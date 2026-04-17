import { useState, useEffect, type ReactNode } from 'react';
import { X, Shield, Scale, Lightbulb, BookOpen, Ghost, User, Users } from 'lucide-react';
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
  icon: ReactNode;
}

const TYPE_OPTIONS: TypeOption[] = [
  { key: 'error_pattern', label: 'ERROR', icon: <Shield size={16} /> },
  { key: 'convention', label: 'CONV', icon: <Scale size={16} /> },
  { key: 'decision', label: 'DECISION', icon: <Lightbulb size={16} /> },
  { key: 'learning', label: 'LEARN', icon: <BookOpen size={16} /> },
  { key: 'ghost_knowledge', label: 'GHOST', icon: <Ghost size={16} /> },
];

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

  const scopeDescription = scope === 'personal' ? 'Stays in your notebook' : 'Shared with team';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
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
          background: 'var(--bg)',
          borderRadius: '8px',
          width: '100%',
          maxWidth: '560px',
          margin: '0 16px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '90vh',
          overflow: 'hidden',
          border: '1px solid var(--line)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '16px',
              fontWeight: 700,
              color: 'var(--ink)',
              letterSpacing: '-0.01em',
            }}
          >
            Capture knowledge
          </span>
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
              borderRadius: '4px',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Type picker */}
          <div style={{ padding: '16px 20px 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px' }}>
              {TYPE_OPTIONS.map(opt => {
                const isActive = selectedType === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => setSelectedType(opt.key)}
                    style={{
                      padding: '10px 4px 8px',
                      border: `1px solid ${isActive ? 'var(--ink)' : 'var(--line)'}`,
                      background: isActive ? 'var(--ink)' : 'var(--sunken)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '5px',
                      transition: 'background 120ms, border-color 120ms',
                    }}
                  >
                    <span
                      style={{
                        color: isActive ? '#fff' : 'var(--ink-faint)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '32px',
                        height: '32px',
                      }}
                    >
                      {opt.icon}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: '9px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.07em',
                        color: isActive ? '#fff' : 'var(--ink-soft)',
                        fontWeight: 600,
                      }}
                    >
                      {opt.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scope toggle */}
          <div style={{ padding: '14px 20px 0' }}>
            <div
              style={{
                display: 'flex',
                border: '1px solid var(--line)',
                borderRadius: '6px',
                overflow: 'hidden',
              }}
            >
              {(['personal', 'team'] as const).map((s, i) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  style={{
                    flex: 1,
                    padding: '9px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    fontFamily: 'var(--font-sans)',
                    fontWeight: 500,
                    fontSize: '13px',
                    cursor: 'pointer',
                    border: 'none',
                    borderLeft: i === 1 ? '1px solid var(--line)' : 'none',
                    background: scope === s ? 'var(--ink)' : 'transparent',
                    color: scope === s ? '#fff' : 'var(--ink-faint)',
                    transition: 'background 120ms, color 120ms',
                  }}
                >
                  {s === 'personal' ? <User size={13} /> : <Users size={13} />}
                  <span style={{ textTransform: 'capitalize' }}>{s}</span>
                </button>
              ))}
            </div>
            <p
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '11px',
                color: 'var(--ink-faint)',
                marginTop: '6px',
                paddingLeft: '2px',
              }}
            >
              {scopeDescription}
            </p>
          </div>

          {/* Form fields */}
          <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Title */}
            <div>
              <label
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '9px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.09em',
                  color: 'var(--ink-faint)',
                  display: 'block',
                  marginBottom: '5px',
                  fontWeight: 600,
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
                  borderRadius: '4px',
                  padding: '8px 10px',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '13px',
                  color: 'var(--ink)',
                  background: 'var(--bg)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Content */}
            <div>
              <label
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '9px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.09em',
                  color: 'var(--ink-faint)',
                  display: 'block',
                  marginBottom: '5px',
                  fontWeight: 600,
                }}
              >
                Content
              </label>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Describe the knowledge in detail…"
                style={{
                  width: '100%',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  padding: '8px 10px',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '14px',
                  lineHeight: '1.6',
                  color: 'var(--ink)',
                  background: 'var(--bg)',
                  outline: 'none',
                  resize: 'vertical',
                  minHeight: '120px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Tags */}
            <div>
              <label
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '9px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.09em',
                  color: 'var(--ink-faint)',
                  display: 'block',
                  marginBottom: '5px',
                  fontWeight: 600,
                }}
              >
                Tags
              </label>
              <input
                type="text"
                value={tags}
                onChange={e => setTags(e.target.value)}
                placeholder="auth, database, deployment"
                style={{
                  width: '100%',
                  border: '1px solid var(--line)',
                  borderRadius: '4px',
                  padding: '8px 10px',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '13px',
                  color: 'var(--ink)',
                  background: 'var(--bg)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Error */}
            {error && (
              <p
                style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: '12px',
                  color: '#c00',
                  margin: 0,
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
            padding: '12px 20px',
            borderTop: '1px solid var(--line)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-sans)',
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
                padding: '7px 14px',
                background: 'transparent',
                border: '1px solid var(--line)',
                borderRadius: '4px',
                fontFamily: 'var(--font-sans)',
                fontSize: '13px',
                color: 'var(--ink-soft)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                padding: '7px 18px',
                background: saving ? 'var(--ink-faint)' : 'var(--ink)',
                border: 'none',
                borderRadius: '4px',
                fontFamily: 'var(--font-sans)',
                fontSize: '13px',
                fontWeight: 600,
                color: '#fff',
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
