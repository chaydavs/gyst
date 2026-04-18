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
  const modeTabs: Array<{ key: Mode; label: string }> = [
    { key: 'team', label: 'Team' },
    { key: 'personal', label: 'Personal' },
  ];

  const viewTabs: Array<{ key: View; label: string }> = [
    { key: 'feed', label: 'Feed' },
    { key: 'graph', label: 'Graph' },
    { key: 'queue', label: 'Review' },
    { key: 'team', label: 'Team' },
  ];

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '10px 16px',
    fontFamily: 'var(--font-sans)',
    fontWeight: active ? 600 : 400,
    fontSize: '13px',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid #000' : '2px solid transparent',
    color: active ? '#000' : '#888',
    transition: 'color 100ms',
  });

  return (
    <div
      style={{
        background: '#fff',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        flexShrink: 0,
        position: 'sticky',
        top: '52px',
        zIndex: 30,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0' }}>
        {/* Mode tabs */}
        {modeTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => onModeChange(tab.key)}
            style={tabStyle(mode === tab.key)}
          >
            {tab.label}
          </button>
        ))}

        <span style={{ width: '1px', height: '16px', background: 'var(--line)', margin: '0 8px' }} />

        {/* View tabs */}
        {viewTabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => onViewChange(tab.key)}
            style={tabStyle(view === tab.key)}
          >
            {tab.label}
          </button>
        ))}

        {/* Search */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginLeft: '12px',
            background: 'var(--sunken)',
            border: '1px solid var(--line)',
            borderRadius: '4px',
            padding: '4px 8px',
          }}
        >
          <Search size={12} color="var(--ink-faint)" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => {
              onSearchChange(e.target.value);
              onViewChange('feed');
            }}
            placeholder="Search… (⌘K)"
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontFamily: 'var(--font-sans)',
              fontSize: '12px',
              color: 'var(--ink)',
              width: '180px',
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
