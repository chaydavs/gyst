import { useState, useRef, useEffect } from 'react';
import type { RefObject } from 'react';
import { Search, ChevronDown, Users } from 'lucide-react';
import type { Mode, View, TeamInfo, TeamMember } from '../types';

interface ModeRailProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  teamInfo: TeamInfo | null;
  teamMembers: TeamMember[];
  teamMemberCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef: RefObject<HTMLInputElement>;
  view: View;
  onViewChange: (view: View) => void;
  /** Developer ID to filter feed by (null = show all) */
  developerFilter: string | null;
  onDeveloperFilterChange: (id: string | null) => void;
}

export default function ModeRail({
  mode,
  onModeChange,
  teamInfo,
  teamMembers,
  teamMemberCount,
  searchQuery,
  onSearchChange,
  searchInputRef,
  view,
  onViewChange,
  developerFilter,
  onDeveloperFilterChange,
}: ModeRailProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

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

  const activeFilter = developerFilter
    ? teamMembers.find(m => m.developerId === developerFilter)
    : null;

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

      {/* Right: team member filter dropdown (shown in team mode with members) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {teamInfo && mode === 'team' && teamMembers.length > 0 && (
          <div ref={dropdownRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setDropdownOpen(o => !o)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                background: developerFilter ? 'var(--accent)' : 'var(--sunken)',
                border: '1px solid',
                borderColor: developerFilter ? 'var(--accent)' : 'var(--line)',
                borderRadius: '4px',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
                fontSize: '12px',
                color: developerFilter ? '#fff' : 'var(--ink)',
                transition: 'all 150ms',
              }}
            >
              <Users size={11} />
              {activeFilter ? activeFilter.displayName : 'All members'}
              <ChevronDown size={11} />
            </button>

            {dropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  right: 0,
                  background: '#fff',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
                  minWidth: '200px',
                  zIndex: 100,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '4px 0',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <div
                    style={{
                      padding: '4px 12px 6px',
                      fontFamily: 'var(--font-sans)',
                      fontSize: '10px',
                      fontWeight: 600,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--ink-faint)',
                    }}
                  >
                    Filter by member
                  </div>
                </div>

                <button
                  onClick={() => { onDeveloperFilterChange(null); setDropdownOpen(false); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '8px 12px',
                    background: developerFilter === null ? 'var(--sunken)' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--line)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                    fontSize: '13px',
                    color: 'var(--ink)',
                    textAlign: 'left',
                  }}
                >
                  <span>All members</span>
                  {developerFilter === null && (
                    <span style={{ color: 'var(--accent)', fontSize: '12px' }}>✓</span>
                  )}
                </button>

                {teamMembers.map(member => (
                  <button
                    key={member.developerId}
                    onClick={() => { onDeveloperFilterChange(member.developerId); setDropdownOpen(false); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '8px 12px',
                      background: developerFilter === member.developerId ? 'var(--sunken)' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--line)',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      fontSize: '13px',
                      color: 'var(--ink)',
                      textAlign: 'left',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: developerFilter === member.developerId ? 600 : 400 }}>
                        {member.displayName}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--ink-faint)', marginTop: '1px' }}>
                        {member.entryCount} entr{member.entryCount !== 1 ? 'ies' : 'y'} · {member.role}
                      </div>
                    </div>
                    {developerFilter === member.developerId && (
                      <span style={{ color: 'var(--accent)', fontSize: '12px' }}>✓</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Team name pill */}
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
    </div>
  );
}
