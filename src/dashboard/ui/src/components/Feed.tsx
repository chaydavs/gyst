import { useState, useEffect } from 'react';
import { api } from '../api';
import type { Entry, EntryType, Mode, SearchResult } from '../types';
import EntryCard from './EntryCard';

interface FeedProps {
  mode: Mode;
  searchQuery: string;
  onEntryClick: (id: string) => void;
  refreshKey?: number;
}

type FilterType = 'all' | EntryType;

const FILTER_TYPES: Array<{ key: FilterType; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'error_pattern', label: 'Errors' },
  { key: 'convention', label: 'Conventions' },
  { key: 'decision', label: 'Decisions' },
  { key: 'learning', label: 'Learnings' },
  { key: 'ghost_knowledge', label: 'Ghost' },
];

function searchResultToEntry(r: SearchResult): Entry {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.snippet,
    scope: r.scope,
    confidence: r.confidence,
    createdAt: new Date().toISOString(),
    lastConfirmed: new Date().toISOString(),
    sourceCount: 0,
    sourceTool: null,
    developerId: null,
  };
}

export default function Feed({ mode, searchQuery, onEntryClick, refreshKey }: FeedProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        let result: Entry[];
        if (searchQuery.trim()) {
          const scope = mode === 'team' ? 'team' : 'personal';
          const searchResults = await api.search(searchQuery.trim(), scope);
          result = searchResults.map(searchResultToEntry);
        } else {
          const scope = mode === 'team' ? 'team' : 'personal';
          result = await api.listEntries({ scope, limit: 50 });
        }
        if (!cancelled) {
          setEntries(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load entries');
          setLoading(false);
        }
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [mode, searchQuery, refreshKey]);

  const filtered = filter === 'all' ? entries : entries.filter(e => e.type === filter);

  const sectionTitle = searchQuery
    ? `Results for "${searchQuery}"`
    : mode === 'team'
      ? 'The Team Ledger'
      : 'Your Notebook';

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '24px 32px' }}>
      {/* Section header */}
      <h2
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '14px',
          fontWeight: 600,
          letterSpacing: '-0.01em',
          color: 'var(--ink)',
          marginBottom: '16px',
        }}
      >
        {sectionTitle}
      </h2>

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', flexWrap: 'wrap' }}>
        {FILTER_TYPES.map(ft => (
          <button
            key={ft.key}
            onClick={() => setFilter(ft.key)}
            style={{
              padding: '4px 12px',
              borderRadius: '20px',
              border: '1px solid',
              borderColor: filter === ft.key ? 'var(--accent)' : 'var(--line)',
              background: filter === ft.key ? 'var(--accent)' : 'transparent',
              color: filter === ft.key ? '#FFFFFF' : 'var(--ink-faint)',
              fontFamily: 'var(--font-sans)',
              fontSize: '12px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 150ms',
            }}
          >
            {ft.label}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent)', marginBottom: '16px' }}>
          {error}
        </p>
      )}

      {/* Loading skeletons */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[1, 2, 3].map(i => (
            <div
              key={i}
              style={{
                background: 'var(--sunken)',
                borderRadius: '8px',
                padding: '16px 20px',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            >
              <div style={{ height: '10px', width: '60px', background: 'var(--line)', borderRadius: '4px', marginBottom: '12px' }} />
              <div style={{ height: '20px', width: '80%', background: 'var(--line)', borderRadius: '4px', marginBottom: '8px' }} />
              <div style={{ height: '14px', width: '60%', background: 'var(--line)', borderRadius: '4px' }} />
            </div>
          ))}
          <style>{`
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.5; }
            }
          `}</style>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <h3
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '15px',
              fontWeight: 600,
              color: 'var(--ink-soft)',
              marginBottom: '8px',
            }}
          >
            {searchQuery ? 'No results found' : 'Nothing captured yet'}
          </h3>
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', color: 'var(--ink-faint)' }}>
            {searchQuery
              ? 'Try different keywords or clear the search'
              : mode === 'team'
                ? 'Team knowledge grows as your AI agents work. Press ⌘N to capture something now.'
                : 'Your personal notebook is empty. Press ⌘N to add your first entry.'}
          </p>
        </div>
      )}

      {/* Entries list */}
      {!loading && filtered.map(entry => (
        <EntryCard
          key={entry.id}
          entry={entry}
          onClick={() => onEntryClick(entry.id)}
        />
      ))}
    </div>
  );
}
