import { useState, useEffect, type ReactNode } from 'react';
import { ArrowLeft, Share2 } from 'lucide-react';
import { api } from '../api';
import type { EntryDetail, EntryType } from '../types';

interface EntryDrawerProps {
  id: string;
  onClose: () => void;
  onPromote: (id: string) => void;
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

function confidenceColor(c: number): string {
  if (c >= 0.7) return '#1E7A3F';
  if (c >= 0.4) return '#C27B0E';
  return '#D4412B';
}

export default function EntryDrawer({ id, onClose, onPromote }: EntryDrawerProps) {
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedbackState, setFeedbackState] = useState<'idle' | 'accurate' | 'stale'>('idle');
  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Trigger slide-in animation
    requestAnimationFrame(() => setMounted(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.getEntry(id)
      .then(e => {
        if (!cancelled) {
          setEntry(e);
          setEditTitle(e.title);
          setEditContent(e.content);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load entry');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [id]);

  const handleFeedback = async (helpful: boolean) => {
    if (!entry) return;
    try {
      await api.feedback(entry.id, helpful);
      setFeedbackState(helpful ? 'accurate' : 'stale');
    } catch {
      // ignore
    }
  };

  const handlePromote = async () => {
    if (!entry) return;
    try {
      await api.promote(entry.id);
      onPromote(entry.id);
    } catch {
      // ignore
    }
  };

  const handleSaveEdit = async () => {
    if (!entry) return;
    try {
      const updated = await api.updateEntry(entry.id, {
        title: editTitle,
        content: editContent,
      });
      setEntry({ ...entry, ...updated });
      setEditMode(false);
    } catch {
      // ignore
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        height: '100%',
        width: '620px',
        background: 'var(--elevated)',
        borderLeft: '1px solid var(--line)',
        boxShadow: '-8px 0 32px rgba(26,23,18,0.12)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        transform: mounted ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 250ms ease',
      }}
    >
      {/* Sticky header */}
      <div
        style={{
          background: 'var(--elevated)',
          borderBottom: '1px solid var(--line)',
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onClose}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--ink-faint)',
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
          }}
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <button
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            border: '1px solid var(--line)',
            borderRadius: '6px',
            cursor: 'pointer',
            color: 'var(--ink-faint)',
            fontFamily: 'var(--font-sans)',
            fontSize: '12px',
            padding: '5px 10px',
          }}
        >
          <Share2 size={13} />
          Share
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ height: '10px', width: '80px', background: 'var(--sunken)', borderRadius: '4px', animation: 'pulse 1.5s ease-in-out infinite' }} />
            <div style={{ height: '32px', width: '90%', background: 'var(--sunken)', borderRadius: '4px', animation: 'pulse 1.5s ease-in-out infinite' }} />
            <div style={{ height: '14px', width: '70%', background: 'var(--sunken)', borderRadius: '4px', animation: 'pulse 1.5s ease-in-out infinite' }} />
            <style>{`
              @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
              }
            `}</style>
          </div>
        )}

        {error && (
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent)' }}>{error}</p>
        )}

        {!loading && entry && (
          <div>
            {/* Type + scope + source tool chips */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: TYPE_COLORS[entry.type],
                  background: `${TYPE_COLORS[entry.type]}20`,
                  padding: '3px 8px',
                  borderRadius: '3px',
                  fontWeight: 600,
                }}
              >
                {TYPE_LABELS[entry.type]}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--ink-faint)',
                  background: 'var(--sunken)',
                  padding: '3px 8px',
                  borderRadius: '3px',
                }}
              >
                {entry.scope}
              </span>
              {entry.sourceTool && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '10px',
                    color: 'var(--ink-faint)',
                    background: 'var(--sunken)',
                    padding: '3px 8px',
                    borderRadius: '3px',
                  }}
                >
                  via {entry.sourceTool}
                </span>
              )}
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  color: 'var(--ink-faint)',
                  marginLeft: 'auto',
                }}
              >
                {new Date(entry.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>

            {/* Title */}
            {editMode ? (
              <input
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                onBlur={() => void handleSaveEdit()}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-serif)',
                  fontSize: '32px',
                  fontWeight: 700,
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  padding: '4px 8px',
                  background: 'var(--bg)',
                  lineHeight: 1.2,
                  marginBottom: '24px',
                  outline: 'none',
                }}
                autoFocus
              />
            ) : (
              <h1
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '32px',
                  fontWeight: 700,
                  color: 'var(--ink)',
                  lineHeight: 1.2,
                  marginBottom: '24px',
                }}
              >
                {entry.title}
              </h1>
            )}

            {/* Content */}
            {editMode ? (
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                onBlur={() => void handleSaveEdit()}
                rows={10}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-serif)',
                  fontSize: '17px',
                  lineHeight: 1.65,
                  color: 'var(--ink-soft)',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  background: 'var(--bg)',
                  outline: 'none',
                  resize: 'vertical',
                }}
              />
            ) : (
              <p
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '17px',
                  lineHeight: 1.65,
                  color: 'var(--ink-soft)',
                  whiteSpace: 'pre-wrap',
                  marginBottom: '32px',
                }}
              >
                {entry.content}
              </p>
            )}

            {/* Attached files */}
            {entry.files.length > 0 && (
              <MetaSection label="Attached Files">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {entry.files.map(f => (
                    <span
                      key={f}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--ink-soft)',
                        background: 'var(--sunken)',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--line-soft)',
                      }}
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </MetaSection>
            )}

            {/* Sources */}
            {entry.sources.length > 0 && (
              <MetaSection label="Sources">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {entry.sources.map(s => (
                    <div
                      key={s.id}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--ink-faint)',
                        display: 'flex',
                        gap: '8px',
                      }}
                    >
                      <span>{s.tool}</span>
                      {s.developerId && <span>· {s.developerId}</span>}
                      <span>· {timeAgo(s.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </MetaSection>
            )}

            {/* Confidence */}
            <MetaSection label="Confidence">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ flex: 1, height: '6px', background: 'var(--line)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${entry.confidence * 100}%`,
                      height: '100%',
                      background: confidenceColor(entry.confidence),
                      borderRadius: '3px',
                      transition: 'width 300ms ease',
                    }}
                  />
                </div>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    color: confidenceColor(entry.confidence),
                    fontWeight: 600,
                  }}
                >
                  {Math.round(entry.confidence * 100)}%
                </span>
              </div>
            </MetaSection>

            {/* Tags */}
            {entry.tags.length > 0 && (
              <MetaSection label="Tags">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {entry.tags.map(tag => (
                    <span
                      key={tag}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--ink-soft)',
                        background: 'var(--sunken)',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        border: '1px solid var(--line-soft)',
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </MetaSection>
            )}

            {/* Related entries */}
            {entry.relationships.length > 0 && (
              <MetaSection label="Related">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {entry.relationships.map(rel => (
                    <div
                      key={rel.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 10px',
                        background: 'var(--bg)',
                        borderRadius: '6px',
                        border: '1px solid var(--line-soft)',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '9px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--ink-faint)',
                          flexShrink: 0,
                        }}
                      >
                        {rel.type.replace(/_/g, ' ')}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-serif)',
                          fontSize: '13px',
                          color: 'var(--ink)',
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {rel.relatedTitle}
                      </span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '10px',
                          color: confidenceColor(rel.strength),
                          flexShrink: 0,
                        }}
                      >
                        {Math.round(rel.strength * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </MetaSection>
            )}
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      {entry && (
        <div
          style={{
            borderTop: '1px solid var(--line)',
            padding: '12px 24px',
            display: 'flex',
            gap: '16px',
            alignItems: 'center',
            flexShrink: 0,
            background: 'var(--elevated)',
          }}
        >
          <ActionButton
            label="Still Accurate"
            active={feedbackState === 'accurate'}
            activeColor="#1E7A3F"
            onClick={() => void handleFeedback(true)}
          />
          <ActionButton
            label="Flag Stale"
            active={feedbackState === 'stale'}
            activeColor="#D4412B"
            onClick={() => void handleFeedback(false)}
          />
          {entry.scope === 'personal' && (
            <ActionButton
              label="Promote to Team"
              active={false}
              activeColor="#2B5DD4"
              onClick={() => void handlePromote()}
            />
          )}
          <ActionButton
            label={editMode ? 'Done' : 'Edit'}
            active={editMode}
            activeColor="#C27B0E"
            onClick={() => setEditMode(em => !em)}
          />
        </div>
      )}
    </div>
  );
}

function MetaSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--ink-faint)',
          display: 'block',
          marginBottom: '8px',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function ActionButton({
  label,
  active,
  activeColor,
  onClick,
}: {
  label: string;
  active: boolean;
  activeColor: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: active ? activeColor : 'var(--ink-faint)',
        padding: '4px 0',
        transition: 'color 150ms',
        fontWeight: active ? 600 : 400,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = activeColor; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = active ? activeColor : 'var(--ink-faint)'; }}
    >
      {label}
    </button>
  );
}
