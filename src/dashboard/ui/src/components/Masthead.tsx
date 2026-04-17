import { Bell } from 'lucide-react';

interface MastheadProps {
  reviewQueueCount: number;
  onCapture: () => void;
  onInvite: () => void;
}

function formatDate(): string {
  const now = new Date();
  return now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).toUpperCase();
}

export default function Masthead({ reviewQueueCount, onCapture, onInvite }: MastheadProps) {
  return (
    <header
      style={{
        background: '#1A1712',
        color: '#F5F1E8',
        height: '88px',
        position: 'sticky',
        top: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        flexShrink: 0,
      }}
    >
      {/* Left: date + wordmark + tagline */}
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            color: '#8B8172',
            marginBottom: '2px',
          }}
        >
          {formatDate()}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '52px',
            fontWeight: 900,
            fontStyle: 'italic',
            lineHeight: 1,
            color: '#F5F1E8',
          }}
        >
          Gyst
        </span>
        <span
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: '13px',
            fontStyle: 'italic',
            color: '#8B8172',
            marginTop: '2px',
          }}
        >
          Team knowledge, grounded in code
        </span>
      </div>

      {/* Right: bell + invite + capture */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Notification bell */}
        <button
          style={{
            position: 'relative',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: '#8B8172',
            padding: '6px',
            display: 'flex',
            alignItems: 'center',
          }}
          aria-label="Notifications"
        >
          <Bell size={18} />
          {reviewQueueCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: '4px',
                right: '4px',
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: '#D4412B',
              }}
            />
          )}
        </button>

        {/* Invite button */}
        <button
          onClick={onInvite}
          style={{
            border: '1px solid #4A4438',
            background: 'transparent',
            color: '#8B8172',
            padding: '8px 16px',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 500,
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
            transition: 'color 150ms, border-color 150ms',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.color = '#F5F1E8';
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#F5F1E8';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.color = '#8B8172';
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#4A4438';
          }}
        >
          Invite
        </button>

        {/* Capture button */}
        <button
          onClick={onCapture}
          style={{
            background: '#D4412B',
            color: '#FFFFFF',
            border: 'none',
            padding: '8px 16px',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 600,
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
            transition: 'background 150ms',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#C23A26'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#D4412B'; }}
        >
          Capture
        </button>
      </div>
    </header>
  );
}
