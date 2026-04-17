import { useState, useEffect, type ReactNode } from 'react';
import { X, Shield, Scale, Lightbulb, BookOpen, Ghost } from 'lucide-react';
import { api } from '../api';
import type { Entry, EntryType, Mode } from '../types';

interface CaptureModalProps {
  onClose: () => void;
  onSaved: (entry: Entry) => void;
  defaultScope: Mode;
}

interface TypeOption {
  key: EntryType;
  label: string;
  description: string;
  icon: ReactNode;
}

const TYPE_OPTIONS: TypeOption[] = [
  {
    key: 'error_pattern',
    label: 'ERROR',
    description: 'Known bugs & gotchas',
    icon: <Shield size={16} />,
  },
  {
    key: 'convention',
    label: 'CONVENTION',
    description: 'Coding standards',
    icon: <Scale size={16} />,
  },
  {
    key: 'decision',
    label: 'DECISION',
    description: 'Architecture choices',
    icon: <Lightbulb size={16} />,
  },
  {
    key: 'learning',
    label: 'LEARNING',
    description: 'Things we discovered',
    icon: <BookOpen size={16} />,
  },
  {
    key: 'ghost_knowledge',
    label: 'GHOST',
    description: 'Undocumented wisdom',
    icon: <Ghost size={16} />,
  },
];

const TYPE_COLORS: Record<EntryType, string> = {
  ghost_knowledge: '#7B2D8E',
  error_pattern: '#D4412B',
  decision: '#2B5DD4',
  convention: '#1E7A3F',
  learning: '#C27B0E',
};

export default function CaptureModal({ onClose, onSaved, defaultScope }: CaptureModalProps) {
  const [selectedType, setSelectedType] = useState<EntryType>('learning');
  const [scope, setScope] = useState<'personal' | 'team'>(defaultScope === 'personal' ? 'personal' : 'team');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        void handleSave();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) {
      setError('Title and content are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tagList = tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const created = await api.createEntry({
        type: selectedType,
        title: title.trim(),
        content: content.trim(),
        scope,
        tags: tagList,
      });
      // Build a minimal Entry object to pass back
      const entry: Entry = {
        id: created.id,
        type: selectedType,
        title: created.title,
        content: content.trim(),
        scope: created.scope as 'team' | 'personal' | 'project',
        confidence: 0.8,
        createdAt: new Date().toISOString(),
        lastConfirmed: new Date().toISOString(),
        sourceCount: 0,
        sourceTool: null,
        developerId: null,
      };
      onSaved(entry);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save entry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--elevated)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '600px',
          margin: '0 16px',
          boxShadow: '0 24px 64px rgba(26,23,18,0.25)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--line-soft)',
          }}
        >
          <h2
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '22px',
              fontWeight: 700,
              color: 'var(--ink)',
            }}
          >
            Capture Knowledge
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--ink-faint)',
              display: 'flex',
              alignItems: 'center',
              padding: '4px',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', padding: '0 0 0 0', flex: 1 }}>
          {/* Type picker */}
          <div style={{ padding: '16px 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' }}>
              {TYPE_OPTIONS.map(opt => {
                const isActive = selectedType === opt.key;
                const color = TYPE_COLORS[opt.key];
                return (
                  <button
                    key={opt.key}
                    onClick={() => setSelectedType(opt.key)}
                    style={{
                      padding: '10px 6px',
                      border: `1px solid ${isActive ? color : 'var(--line)'}`,
                      background: isActive ? `${color}14` : 'transparent',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '4px',
                      transition: 'all 150ms',
                    }}
                  >
                    <span style={{ color: isActive ? color : 'var(--ink-faint)' }}>{opt.icon}</span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '9px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: isActive ? color : 'var(--ink-soft)',
                        fontWeight: isActive ? 600 : 400,
                      }}
                    >
                      {opt.label}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: '10px',
                        color: 'var(--ink-faint)',
                        textAlign: 'center',
                        lineHeight: 1.3,
                      }}
                    >
                      {opt.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scope toggle */}
          <div style={{ padding: '0 24px 16px' }}>
            <div
              style={{
                background: 'var(--sunken)',
                padding: '4px',
                borderRadius: '8px',
                display: 'flex',
              }}
            >
              {(['personal', 'team'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  style={{
                    flex: 1,
                    padding: '8px',
                    borderRadius: '6px',
                    textAlign: 'center',
                    fontFamily: 'var(--font-sans)',
                    fontWeight: 500,
                    fontSize: '14px',
                    cursor: 'pointer',
                    border: 'none',
                    background: scope === s ? 'var(--elevated)' : 'transparent',
                    color: scope === s ? 'var(--ink)' : 'var(--ink-faint)',
                    boxShadow: scope === s ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    transition: 'all 150ms',
                    textTransform: 'capitalize',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            <p
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '12px',
                color: 'var(--ink-faint)',
                marginTop: '6px',
                textAlign: 'center',
              }}
            >
              {scope === 'personal'
                ? 'Stays in your notebook'
                : 'Visible to your whole team'}
            </p>
          </div>

          {/* Form fields */}
          <div style={{ padding: '0 24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--ink-faint)',
                  display: 'block',
                  marginBottom: '4px',
                }}
              >
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="What did you learn?"
                style={{
                  width: '100%',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '14px',
                  color: 'var(--ink)',
                  background: 'var(--bg)',
                  outline: 'none',
                }}
              />
            </div>

            <div>
              <label
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--ink-faint)',
                  display: 'block',
                  marginBottom: '4px',
                }}
              >
                Content
              </label>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Describe the knowledge in detail…"
                rows={8}
                style={{
                  width: '100%',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  fontFamily: 'var(--font-serif)',
                  fontSize: '15px',
                  lineHeight: '1.65',
                  color: 'var(--ink)',
                  background: 'var(--bg)',
                  outline: 'none',
                  resize: 'vertical',
                }}
              />
            </div>

            <div>
              <label
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--ink-faint)',
                  display: 'block',
                  marginBottom: '4px',
                }}
              >
                Tags (optional, comma-separated)
              </label>
              <input
                type="text"
                value={tags}
                onChange={e => setTags(e.target.value)}
                placeholder="auth, database, deployment"
                style={{
                  width: '100%',
                  border: '1px solid var(--line)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '14px',
                  color: 'var(--ink)',
                  background: 'var(--bg)',
                  outline: 'none',
                }}
              />
            </div>

            {error && (
              <p
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  color: 'var(--accent)',
                }}
              >
                {error}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 24px',
            borderTop: '1px solid var(--line-soft)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--ink-faint)',
            }}
          >
            ⌘ Enter to save
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={onClose}
              style={{
                padding: '8px 16px',
                background: 'transparent',
                border: '1px solid var(--line)',
                borderRadius: '6px',
                fontFamily: 'var(--font-sans)',
                fontSize: '13px',
                color: 'var(--ink-faint)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                padding: '8px 20px',
                background: saving ? '#A0322099' : 'var(--accent)',
                border: 'none',
                borderRadius: '6px',
                fontFamily: 'var(--font-sans)',
                fontSize: '13px',
                fontWeight: 600,
                color: '#FFFFFF',
                cursor: saving ? 'default' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
