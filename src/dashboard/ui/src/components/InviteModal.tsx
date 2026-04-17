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

export default function InviteModal({ onClose, teamInfo }: InviteModalProps) {
  const [detectedTools, setDetectedTools] = useState<DetectedTool[]>([]);
  const [inviteData, setInviteData] = useState<InviteData | null>(null);
  const { copied: copiedInstall, copy: copyInstall } = useCopy();
  const { copied: copiedInvite, copy: copyInvite } = useCopy();

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
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
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
          background: 'var(--elevated)',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '560px',
          margin: '0 16px',
          boxShadow: '0 24px 64px rgba(26,23,18,0.25)',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '24px 24px 16px',
            borderBottom: '1px solid var(--line-soft)',
          }}
        >
          <div>
            <h2
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: '28px',
                fontWeight: 600,
                fontStyle: 'italic',
                color: 'var(--ink)',
                lineHeight: 1.2,
                marginBottom: '6px',
              }}
            >
              Let's get your team on the same page.
            </h2>
            <p
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                color: 'var(--ink-faint)',
              }}
            >
              Each teammate's AI agent contributes to your shared knowledge base.
            </p>
          </div>
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
              flexShrink: 0,
              marginLeft: '16px',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '24px', flex: 1, display: 'flex', flexDirection: 'column', gap: '28px' }}>
          {/* Step 1 */}
          <div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '64px',
                  fontWeight: 300,
                  fontStyle: 'italic',
                  color: 'var(--line)',
                  lineHeight: 0.9,
                  flexShrink: 0,
                  width: '40px',
                }}
              >
                1
              </span>
              <div style={{ flex: 1 }}>
                <h3
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: '18px',
                    fontWeight: 600,
                    color: 'var(--ink)',
                    marginBottom: '8px',
                  }}
                >
                  Install
                </h3>
                <p
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: '13px',
                    color: 'var(--ink-faint)',
                    marginBottom: '10px',
                  }}
                >
                  Run this in each developer's terminal to set up the MCP server.
                </p>
                <CodeBlock code={installCmd} onCopy={copyInstall} copied={copiedInstall} />
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '64px',
                  fontWeight: 300,
                  fontStyle: 'italic',
                  color: 'var(--line)',
                  lineHeight: 0.9,
                  flexShrink: 0,
                  width: '40px',
                }}
              >
                2
              </span>
              <div style={{ flex: 1 }}>
                <h3
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: '18px',
                    fontWeight: 600,
                    color: 'var(--ink)',
                    marginBottom: '8px',
                  }}
                >
                  Connect your tools
                </h3>
                <p
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: '13px',
                    color: 'var(--ink-faint)',
                    marginBottom: '12px',
                  }}
                >
                  Gyst works with the tools your team already uses.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
                  {TOOL_DISPLAY.map(tool => {
                    const detected = detectedTools.find(
                      dt => dt.name.toLowerCase() === tool.name.toLowerCase()
                    );
                    const isDetected = detected?.detected ?? false;

                    return (
                      <div
                        key={tool.name}
                        style={{
                          padding: '8px 10px',
                          border: `1px solid ${isDetected ? '#1E7A3F66' : 'var(--line)'}`,
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          background: isDetected ? '#1E7A3F0A' : 'transparent',
                        }}
                      >
                        {isDetected ? (
                          <Check size={12} color="#1E7A3F" />
                        ) : (
                          <span
                            style={{
                              width: '12px',
                              height: '12px',
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
                            fontSize: '12px',
                            color: isDetected ? '#1E7A3F' : 'var(--ink-faint)',
                            fontWeight: isDetected ? 500 : 400,
                          }}
                        >
                          {tool.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '64px',
                  fontWeight: 300,
                  fontStyle: 'italic',
                  color: 'var(--line)',
                  lineHeight: 0.9,
                  flexShrink: 0,
                  width: '40px',
                }}
              >
                3
              </span>
              <div style={{ flex: 1 }}>
                <h3
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: '18px',
                    fontWeight: 600,
                    color: 'var(--ink)',
                    marginBottom: '8px',
                  }}
                >
                  Invite link
                </h3>
                <p
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: '13px',
                    color: 'var(--ink-faint)',
                    marginBottom: '10px',
                  }}
                >
                  Share this command with teammates to join your team.
                </p>
                {inviteData ? (
                  <>
                    <CodeBlock
                      code={inviteData.installCommand}
                      onCopy={copyInvite}
                      copied={copiedInvite}
                    />
                    <p
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--ink-faint)',
                        marginTop: '8px',
                      }}
                    >
                      Link expires in 7 days
                    </p>
                  </>
                ) : (
                  <div
                    style={{
                      height: '40px',
                      background: 'var(--sunken)',
                      borderRadius: '6px',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '16px 24px',
            borderTop: '1px solid var(--line-soft)',
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '9px 24px',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: '6px',
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
              fontWeight: 600,
              color: '#FFFFFF',
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
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

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
        background: '#1A1712',
        borderRadius: '6px',
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
      }}
    >
      <code
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          color: '#F5F1E8',
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
          border: '1px solid #4A4438',
          borderRadius: '4px',
          padding: '3px 8px',
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          color: copied ? '#1E7A3F' : '#8B8172',
          cursor: 'pointer',
          flexShrink: 0,
          transition: 'color 150ms',
        }}
      >
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  );
}
