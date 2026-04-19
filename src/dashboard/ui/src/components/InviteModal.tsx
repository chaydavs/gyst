import { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { api } from '../api';
import type { TeamInfo } from '../types';

interface InviteModalProps {
  onClose: () => void;
  teamInfo: TeamInfo | null;
}

interface DetectedTool {
  name: string;
  detected: boolean;
  configPath: string;
}

interface InviteData {
  inviteCode: string;
  expiresAt: string;
  installCommand: string;
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy };
}

const TOOL_DISPLAY: Array<{ name: string; label: string }> = [
  { name: 'claude', label: 'Claude Code' },
  { name: 'cursor', label: 'Cursor' },
  { name: 'codex', label: 'Codex' },
  { name: 'windsurf', label: 'Windsurf' },
  { name: 'cline', label: 'Cline' },
];

function CodeBlock({
  code,
  onCopy,
  copied,
}: {
  code: string;
  onCopy: (text: string) => void;
  copied: boolean;
}) {
  return (
    <div
      style={{
        background: '#111',
        borderRadius: '4px',
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
      }}
    >
      <code
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '12px',
          color: '#e8e8e8',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {code}
      </code>
      <button
        onClick={() => onCopy(code)}
        style={{
          background: 'transparent',
          border: '1px solid #333',
          borderRadius: '3px',
          padding: '3px 8px',
          fontFamily: 'var(--font-sans)',
          fontSize: '10px',
          color: copied ? '#6ee06e' : '#888',
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'color 150ms',
        }}
      >
        {copied ? <Check size={10} /> : 'Copy'}
      </button>
    </div>
  );
}

const AI_TOOLS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'windsurf', label: 'Windsurf' },
  { value: 'cline', label: 'Cline' },
  { value: 'other', label: 'Other' },
];

export default function InviteModal({ onClose, teamInfo }: InviteModalProps) {
  const [detectedTools, setDetectedTools] = useState<DetectedTool[]>([]);
  const [inviteData, setInviteData] = useState<InviteData | null>(null);
  const [inviteeName, setInviteeName] = useState('');
  const [selectedTool, setSelectedTool] = useState('claude');
  const { copied: copiedInstall, copy: copyInstall } = useCopy();
  const { copied: copiedInvite, copy: copyInvite } = useCopy();
  const { copied: copiedPrompt, copy: copyPrompt } = useCopy();

  const teamName = teamInfo?.name ?? 'your-team';
  const installCmd = `npx gyst-mcp install --team ${teamName}`;

  useEffect(() => {
    const loadData = async () => {
      const [tools, invite] = await Promise.allSettled([
        api.getDetectedTools(),
        api.createInvite(),
      ]);
      if (tools.status === 'fulfilled') setDetectedTools(tools.value);
      if (invite.status === 'fulfilled') setInviteData(invite.value);
    };
    void loadData();
  }, []);

  return (
    <>
      {/* Backdrop — clicking it closes the panel */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.25)',
          zIndex: 49,
        }}
      />

      {/* Right-side panel */}
      <div
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          height: '100%',
          width: '380px',
          background: 'var(--bg)',
          borderLeft: '1px solid var(--line)',
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
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
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '14px',
              fontWeight: 700,
              color: 'var(--ink)',
              letterSpacing: '-0.01em',
            }}
          >
            Invite to team
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
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '28px',
          }}
        >
          {/* Step 1 — Install */}
          <div>
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '10px',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--ink-faint)',
                fontWeight: 600,
                display: 'block',
                marginBottom: '8px',
              }}
            >
              01 Install
            </span>
            <p
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '12px',
                color: 'var(--ink-soft)',
                marginBottom: '10px',
                lineHeight: 1.5,
              }}
            >
              Run this in each developer's terminal to set up the MCP server.
            </p>
            <CodeBlock code={installCmd} onCopy={copyInstall} copied={copiedInstall} />
          </div>

          {/* Step 2 — Tools detected */}
          <div>
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '10px',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--ink-faint)',
                fontWeight: 600,
                display: 'block',
                marginBottom: '8px',
              }}
            >
              02 Tools detected
            </span>
            <p
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: '12px',
                color: 'var(--ink-soft)',
                marginBottom: '10px',
                lineHeight: 1.5,
              }}
            >
              Gyst works with the AI coding tools your team already uses.
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '6px',
              }}
            >
              {TOOL_DISPLAY.map(tool => {
                const detected = detectedTools.find(
                  dt => dt.name.toLowerCase() === tool.name.toLowerCase()
                );
                const isDetected = detected?.detected ?? false;

                return (
                  <div
                    key={tool.name}
                    style={{
                      padding: '7px 10px',
                      border: `1px solid ${isDetected ? 'var(--ink)' : 'var(--line)'}`,
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: isDetected ? 'var(--ink)' : 'transparent',
                    }}
                  >
                    {isDetected ? (
                      <Check size={11} color="#fff" strokeWidth={2.5} />
                    ) : (
                      <span
                        style={{
                          width: '11px',
                          height: '11px',
                          borderRadius: '50%',
                          border: '1px solid var(--line)',
                          display: 'inline-block',
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontFamily: 'var(--font-sans)',
                        fontSize: '11px',
                        color: isDetected ? '#fff' : 'var(--ink-faint)',
                        fontWeight: isDetected ? 600 : 400,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {tool.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Who are you inviting? */}
          <div>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ink-faint)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>
              03 Invitee details
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <label style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-soft)', display: 'block', marginBottom: '4px' }}>Name</label>
                <input
                  type="text"
                  placeholder="e.g. Alice"
                  value={inviteeName}
                  onChange={e => setInviteeName(e.target.value)}
                  style={{
                    width: '100%',
                    fontFamily: 'var(--font-sans)',
                    fontSize: '12px',
                    padding: '7px 10px',
                    border: '1px solid var(--line)',
                    borderRadius: '4px',
                    background: 'var(--bg)',
                    color: 'var(--ink)',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              <div>
                <label style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-soft)', display: 'block', marginBottom: '4px' }}>AI tool they use</label>
                <select
                  value={selectedTool}
                  onChange={e => setSelectedTool(e.target.value)}
                  style={{
                    width: '100%',
                    fontFamily: 'var(--font-sans)',
                    fontSize: '12px',
                    padding: '7px 10px',
                    border: '1px solid var(--line)',
                    borderRadius: '4px',
                    background: 'var(--bg)',
                    color: 'var(--ink)',
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {AI_TOOLS.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Step 4 — Join command */}
          <div>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ink-faint)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>
              04 Share join command
            </span>
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--ink-soft)', marginBottom: '10px', lineHeight: 1.5 }}>
              Send this command to {inviteeName || 'your teammate'} — it sets up gyst and connects to the team.
            </p>
            {inviteData ? (() => {
              const name = inviteeName.trim() || 'teammate';
              const joinCmd = `gyst join ${inviteData.inviteCode} "${name}"`;
              return (
                <>
                  <CodeBlock code={joinCmd} onCopy={copyInvite} copied={copiedInvite} />
                  <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', marginTop: '6px' }}>
                    Expires in 7 days · restarts {AI_TOOLS.find(t => t.value === selectedTool)?.label ?? 'AI tool'} automatically
                  </p>
                </>
              );
            })() : (
              <div style={{ height: '40px', background: 'var(--sunken)', borderRadius: '4px', animation: 'pulse 1.5s ease-in-out infinite' }} />
            )}
          </div>

          {/* Step 5 — Agent onboarding prompt */}
          {inviteData && (
            <div>
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ink-faint)', fontWeight: 600, display: 'block', marginBottom: '8px' }}>
                05 Agent onboarding prompt
              </span>
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--ink-soft)', marginBottom: '10px', lineHeight: 1.5 }}>
                Optional: paste this into {AI_TOOLS.find(t => t.value === selectedTool)?.label ?? 'their AI tool'} after joining to bootstrap their KB.
              </p>
              {(() => {
                const name = inviteeName.trim() || 'teammate';
                const tool = AI_TOOLS.find(t => t.value === selectedTool)?.label ?? 'your AI tool';
                const prompt = `You've just joined the ${teamName} team on Gyst. Your name is ${name}.\n\n1. Run \`gyst join ${inviteData.inviteCode} "${name}"\` in your terminal.\n2. Restart ${tool} when it finishes.\n3. Run \`gyst self-document --skip-ghosts\` to bootstrap the KB from this codebase.\n4. Then use the \`recall\` tool to check what the team already knows about this codebase.`;
                return (
                  <div
                    style={{
                      background: '#111',
                      borderRadius: '4px',
                      padding: '12px 14px',
                      position: 'relative',
                    }}
                  >
                    <pre style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: '#e8e8e8', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                      {prompt}
                    </pre>
                    <button
                      onClick={() => copyPrompt(prompt)}
                      style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        background: 'transparent',
                        border: '1px solid #333',
                        borderRadius: '3px',
                        padding: '3px 8px',
                        cursor: 'pointer',
                        color: copiedPrompt ? '#22c55e' : '#888',
                        fontSize: '11px',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      {copiedPrompt ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid var(--line)',
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            style={{
              width: '100%',
              padding: '10px',
              background: 'var(--ink)',
              border: 'none',
              borderRadius: '4px',
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
              fontWeight: 600,
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      `}</style>
    </>
  );
}
