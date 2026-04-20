import { useViewMode } from '../context/ViewMode';

/** Pill toggle that switches between Simple and Advanced views. */
export default function ViewToggle() {
  const { mode, setMode } = useViewMode();

  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    background: '#f2f2f2',
    border: '1px solid #e0e0e0',
    borderRadius: '20px',
    padding: '2px',
    gap: '2px',
  };

  const pillStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    borderRadius: '16px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'var(--font-sans)',
    fontWeight: active ? 600 : 400,
    background: active ? '#7c3aed' : 'transparent',
    color: active ? '#fff' : '#888',
    transition: 'background 150ms, color 150ms',
    letterSpacing: '0.01em',
  });

  return (
    <div style={containerStyle} role="group" aria-label="View mode">
      <button
        style={pillStyle(mode === 'simple')}
        onClick={() => setMode('simple')}
        aria-pressed={mode === 'simple'}
      >
        Simple
      </button>
      <button
        style={pillStyle(mode === 'advanced')}
        onClick={() => setMode('advanced')}
        aria-pressed={mode === 'advanced'}
      >
        Advanced
      </button>
    </div>
  );
}
