import type { RefObject } from 'react';
import { Search } from 'lucide-react';
import type { Mode, View, TeamInfo } from '../types';

interface ModeRailProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  teamInfo: TeamInfo | null;
  teamMemberCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef: RefObject<HTMLInputElement>;
  view: View;
  onViewChange: (view: View) => void;
}

export default function ModeRail({
  mode,
  onModeChange,
  teamInfo,
  teamMemberCount,
  searchQuery,
  onSearchChange,
  searchInputRef,
  view,
  onViewChange,
}: ModeRailProps) {
  const tabs: Array<{ key: Mode; label: string }> = [
    { key: 'team', label: 'Team' },
    { key: 'personal', label: 'Personal' },
  ];

  return (
    <div
      style={{
        background: 'var(--elevated)',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        flexShrink: 0,
        position: 'sticky',
        top: '88px',
        zIndex: 30,
      }}
    >
      {/* Left: mode tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => onModeChange(tab.key)}
            style={{
              padding: '12px 20px',
              fontFamily: 'var(--font-sans)',
              fontWeight: 500,
              fontSize: '14px',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              borderBottom: mode === tab.key ? '2px solid var(--accent)' : '2px solid transparent',
              color: mode === tab.key ? 'var(--ink)' : 'var(--ink-faint)',
              position: 'relative',
              transition: 'color 150ms',
            }}
          >
            {tab.label}
          </button>
        ))}

        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginLeft: '16px',
            background: 'var(--sunken)',
            border: '1px solid var(--line)',
            borderRadius: '6px',
            padding: '5px 10px',
          }}
        >
          <Search size={13} color="var(--ink-faint)" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => {
              onSearchChange(e.target.value);
              onViewChange('search');
            }}
            placeholder="Search knowledge… (⌘K)"
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
              color: 'var(--ink)',
              width: '220px',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => { onSearchChange(''); onViewChange('feed'); }}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: '14px', lineHeight: 1 }}
            >
              ×
            </button>
          )}
        </div>

        {/* Queue tab */}
        <button
          onClick={() => onViewChange('queue')}
          style={{
            padding: '12px 20px',
            fontFamily: 'var(--font-sans)',
            fontWeight: 500,
            fontSize: '14px',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            borderBottom: view === 'queue' ? '2px solid var(--accent)' : '2px solid transparent',
            color: view === 'queue' ? 'var(--ink)' : 'var(--ink-faint)',
            transition: 'color 150ms',
          }}
        >
          Review Queue
        </button>
      </div>

      {/* Right: team info */}
      {teamInfo && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--ink-faint)',
          }}
        >
          {teamInfo.name} · {teamMemberCount} member{teamMemberCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}
