import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import type { Stats, Analytics, DriftReport } from '../types';
import { useViewMode } from '../context/ViewMode';
import GraphCanvas from './GraphCanvas';
import EntryDrawer from './EntryDrawer';
import ViewToggle from './ViewToggle';
import Feed from './Feed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function driftColor(score: number): string {
  if (score < 0.1) return '#059669';
  if (score < 0.3) return '#d97706';
  return '#dc2626';
}

function driftLabel(score: number): string {
  if (score < 0.1) return 'Healthy';
  if (score < 0.3) return 'Watch';
  return 'Degraded';
}

function fmtLeverage(ratio: number | undefined): string {
  if (ratio == null || ratio === 0) return '—';
  return `${ratio.toFixed(1)}×`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface StatusCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}

function StatusCard({ label, value, sub }: StatusCardProps) {
  return (
    <div style={{
      flex: '1 1 180px',
      minWidth: '160px',
      background: 'var(--elevated)',
      border: '1px solid var(--line)',
      borderRadius: '6px',
      padding: '16px 20px',
    }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
        {label}
      </div>
      <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--ink)', lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--ink-faint)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

interface QuickActionButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
}

function QuickActionButton({ label, onClick, variant = 'secondary' }: QuickActionButtonProps) {
  const baseStyle: React.CSSProperties = {
    padding: '8px 16px',
    borderRadius: '4px',
    border: '1px solid var(--line)',
    cursor: 'pointer',
    fontSize: '13px',
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    transition: 'background 120ms',
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: { background: '#7c3aed', color: '#fff', border: 'none' },
    secondary: { background: '#fff', color: 'var(--ink)' },
    ghost: { background: 'transparent', color: 'var(--ink-soft)' },
  };

  return (
    <button style={{ ...baseStyle, ...variantStyles[variant] }} onClick={onClick}>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Feed modal
// ---------------------------------------------------------------------------

function FeedModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#fff', borderRadius: '8px',
        width: 'min(860px, 92vw)', height: '80vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--line)',
        }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>All Entries</span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--ink-faint)', lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <Feed mode="team" searchQuery="" onEntryClick={() => undefined} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding placeholder shown when KB is sparse
// ---------------------------------------------------------------------------

function OnboardingPlaceholder() {
  return (
    <div style={{
      flex: 1,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: '16px',
      border: '1px dashed var(--line)',
      borderRadius: '6px',
      minHeight: '300px',
      padding: '40px 24px',
      background: 'var(--elevated)',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '32px' }}>🌱</div>
      <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--ink)' }}>
        Your context layer is just getting started
      </div>
      <div style={{ fontSize: '13px', color: 'var(--ink-faint)', maxWidth: '420px' }}>
        Run a coding session to start capturing knowledge, or bootstrap from your codebase right now:
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{
          background: 'var(--sunken)', border: '1px solid var(--line)', borderRadius: '4px',
          padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--ink)',
        }}>
          gyst mine
        </div>
        <div style={{
          background: 'var(--sunken)', border: '1px solid var(--line)', borderRadius: '4px',
          padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--ink)',
        }}>
          gyst self-document
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main SimpleView
// ---------------------------------------------------------------------------

/** The default single-page dashboard view. Simple, scannable, graph-first. */
export default function SimpleView() {
  const { setMode } = useViewMode();

  const [stats, setStats] = useState<Stats | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [drift, setDrift] = useState<DriftReport | null>(null);
  const [feedRefreshKey] = useState(0);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [showFeedModal, setShowFeedModal] = useState(false);
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [isMobile, setIsMobile] = useState(false);

  // Responsive: track viewport width
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Initial data load
  useEffect(() => {
    const load = async () => {
      const results = await Promise.allSettled([
        api.getStats(),
        api.getAnalytics(),
        api.getDrift(),
      ]);
      if (results[0].status === 'fulfilled') setStats(results[0].value);
      if (results[1].status === 'fulfilled') setAnalytics(results[1].value);
      if (results[2].status === 'fulfilled') setDrift(results[2].value);
    };
    void load();
  }, []);

  const handleExportContext = useCallback(async () => {
    setExportStatus('loading');
    try {
      await fetch('/api/export-context', { method: 'POST' });
      setExportStatus('done');
    } catch {
      setExportStatus('error');
    } finally {
      setTimeout(() => setExportStatus('idle'), 2500);
    }
  }, []);

  const totalEntries = stats?.entries ?? 0;
  const isSparsing = totalEntries < 10;

  const driftScore = drift?.score ?? 0;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', overflowY: 'auto' }}>

      {/* ── Header bar ───────────────────────────────────────────────── */}
      <header style={{
        background: '#000', color: '#fff',
        height: '52px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 24px', flexShrink: 0, position: 'sticky', top: 0, zIndex: 40,
      }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: '15px', fontWeight: 700, letterSpacing: '-0.02em' }}>
          Gyst
        </span>
        <ViewToggle />
      </header>

      {/* Mobile notice for Advanced view */}
      {isMobile && (
        <div style={{
          background: '#fef3c7', borderBottom: '1px solid #fde68a',
          padding: '8px 16px', fontSize: '12px', color: '#92400e', textAlign: 'center',
        }}>
          Advanced view is best on desktop.
        </div>
      )}

      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px 24px 48px' }}>

        {/* ── Section A: Status Bar ─────────────────────────────────── */}
        <section style={{ marginBottom: '32px' }}>
          <div style={{
            display: 'flex', flexWrap: 'wrap',
            gap: '12px',
          }}>
            <StatusCard
              label="Context Savings"
              value={analytics ? fmtLeverage(analytics.leverageRatio) : 'Building…'}
              sub={analytics && analytics.leverageRatio > 0
                ? `${analytics.totalRecalls} recalls · ${analytics.zeroResultRate !== undefined ? `${Math.round(analytics.zeroResultRate * 100)}% zero-result` : ''}`
                : 'Run a session to start tracking'}
            />
            <StatusCard
              label="Knowledge Base"
              value={totalEntries}
              sub={`${stats?.byType ? Object.keys(stats.byType).length : 0} types active`}
            />
            <StatusCard
              label="Health"
              value={
                <span style={{ color: driftColor(driftScore) }}>
                  {driftLabel(driftScore)}
                </span>
              }
              sub={drift
                ? `Drift score: ${driftScore.toFixed(2)}${drift.fatigueWarning ? ' · Fatigue warning' : ''}`
                : 'Loading…'}
            />
          </div>
        </section>

        {/* ── Section B: Knowledge Graph ───────────────────────────── */}
        <section style={{ marginBottom: '32px' }}>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: '10px',
            textTransform: 'uppercase', letterSpacing: '0.10em',
            color: 'var(--ink-faint)', marginBottom: '12px',
          }}>
            Knowledge Graph
          </div>

          {isSparsing ? (
            <OnboardingPlaceholder />
          ) : (
            <div style={{
              border: '1px solid var(--line)', borderRadius: '6px',
              overflow: 'hidden', height: '480px', position: 'relative',
            }}>
              <GraphCanvas
                onNodeClick={setSelectedEntryId}
                refreshKey={feedRefreshKey}
              />
            </div>
          )}
        </section>

        {/* ── Section C: Recent Activity ───────────────────────────── */}
        <section style={{ marginBottom: '32px' }}>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: '10px',
            textTransform: 'uppercase', letterSpacing: '0.10em',
            color: 'var(--ink-faint)', marginBottom: '12px',
          }}>
            Recent Entries
          </div>
          <div style={{
            border: '1px solid var(--line)', borderRadius: '6px',
            overflow: 'hidden', maxHeight: '340px', overflowY: 'auto',
          }}>
            <Feed
              mode="team"
              searchQuery=""
              onEntryClick={setSelectedEntryId}
              refreshKey={feedRefreshKey}
            />
          </div>
        </section>

        {/* ── Section D: Quick Actions ──────────────────────────────── */}
        <section>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: '10px',
            textTransform: 'uppercase', letterSpacing: '0.10em',
            color: 'var(--ink-faint)', marginBottom: '12px',
          }}>
            Quick Actions
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <QuickActionButton
              label="Explore All Entries"
              onClick={() => setShowFeedModal(true)}
              variant="secondary"
            />
            <QuickActionButton
              label={
                exportStatus === 'loading' ? 'Regenerating…'
                  : exportStatus === 'done' ? 'Done!'
                  : exportStatus === 'error' ? 'Failed — retry'
                  : 'Regenerate Context Files'
              }
              onClick={handleExportContext}
              variant="secondary"
            />
            <QuickActionButton
              label="Switch to Advanced"
              onClick={() => setMode('advanced')}
              variant="primary"
            />
          </div>
        </section>
      </div>

      {/* ── Modals ──────────────────────────────────────────────────── */}
      {showFeedModal && <FeedModal onClose={() => setShowFeedModal(false)} />}

      {selectedEntryId && (
        <EntryDrawer
          id={selectedEntryId}
          onClose={() => setSelectedEntryId(null)}
          onPromote={() => setSelectedEntryId(null)}
          onDelete={() => setSelectedEntryId(null)}
        />
      )}
    </div>
  );
}
