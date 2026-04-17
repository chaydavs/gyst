import { Bell } from 'lucide-react';

interface MastheadProps {
  reviewQueueCount: number;
  isLive: boolean;
  onCapture: () => void;
  onInvite: () => void;
}

export default function Masthead({ reviewQueueCount, isLive, onCapture, onInvite }: MastheadProps) {
  return (
    <header
      style={{
        background: '#000',
        color: '#fff',
        height: '52px',
        position: 'sticky',
        top: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        flexShrink: 0,
      }}
    >
      {/* Wordmark */}
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '15px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: '#fff',
        }}
      >
        Gyst
      </span>

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Live indicator */}
        <span
          title={isLive ? 'Live' : 'Connecting…'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: isLive ? '#aaa' : '#555',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            marginRight: '4px',
          }}
        >
          <span
            style={{
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              background: isLive ? '#fff' : '#444',
            }}
          />
          {isLive ? 'Live' : 'Off'}
        </span>

        {/* Bell */}
        <button
          style={{
            position: 'relative',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: '#888',
            padding: '6px',
            display: 'flex',
            alignItems: 'center',
          }}
          aria-label="Notifications"
        >
          <Bell size={15} />
          {reviewQueueCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: '4px',
                right: '4px',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: '#fff',
              }}
            />
          )}
        </button>

        {/* Invite */}
        <button
          onClick={onInvite}
          style={{
            border: '1px solid #444',
            background: 'transparent',
            color: '#aaa',
            padding: '5px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.color = '#fff';
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#fff';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.color = '#aaa';
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#444';
          }}
        >
          Invite
        </button>

        {/* Capture */}
        <button
          onClick={onCapture}
          style={{
            background: '#fff',
            color: '#000',
            border: 'none',
            padding: '5px 14px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: 600,
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#e0e0e0'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#fff'; }}
        >
          + Capture
        </button>
      </div>
    </header>
  );
}
