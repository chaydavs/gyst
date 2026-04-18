import { useState } from 'react';
import { api } from '../api';
import type { TeamInfo } from '../types';

interface TeamSetupWizardProps {
  onComplete: (teamInfo: TeamInfo) => void;
}

type Step = 'name' | 'serve' | 'invite';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      style={{
        fontSize: '11px', padding: '5px 10px', cursor: 'pointer',
        border: '1px solid var(--line)', borderRadius: '4px',
        background: copied ? '#000' : '#fff', color: copied ? '#fff' : '#000',
        fontFamily: 'var(--font-mono)', transition: 'all 150ms', flexShrink: 0,
      }}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div style={{
      background: 'var(--sunken)', border: '1px solid var(--line)', borderRadius: '4px',
      padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '8px',
    }}>
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--ink)', flex: 1, wordBreak: 'break-all' }}>
        {code}
      </code>
      <CopyButton text={code} label="Copy" />
    </div>
  );
}

export default function TeamSetupWizard({ onComplete }: TeamSetupWizardProps) {
  const [step, setStep] = useState<Step>('name');
  const [teamName, setTeamName] = useState('');
  const [serverUrl, setServerUrl] = useState('http://localhost:3456');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdTeam, setCreatedTeam] = useState<TeamInfo | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);

  const handleCreateTeam = async () => {
    const name = teamName.trim() || 'My Team';
    setIsCreating(true);
    setError(null);
    try {
      const result = await api.createTeam(name);
      const info: TeamInfo = { id: result.teamId, name: result.name, createdAt: new Date().toISOString(), memberCount: 1 };
      setCreatedTeam(info);
      setStep('serve');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 409 means team already exists — treat as success and move on
      if (msg.includes('409')) {
        const existing = await api.getTeamInfo();
        if (existing) {
          setCreatedTeam(existing);
          setStep('serve');
          return;
        }
      }
      setError(msg);
    } finally {
      setIsCreating(false);
    }
  };

  const handleGenerateInvite = async () => {
    setIsGeneratingInvite(true);
    setError(null);
    try {
      const result = await api.createInvite();
      setInviteCode(result.inviteCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGeneratingInvite(false);
    }
  };

  const joinCommand = inviteCode
    ? `gyst join ${inviteCode} "Their Name" --server ${serverUrl}`
    : null;

  const steps: Step[] = ['name', 'serve', 'invite'];
  const stepIndex = steps.indexOf(step);

  const stepLabel = (s: Step) => ({ name: 'Name team', serve: 'Start server', invite: 'Invite member' }[s]);

  return (
    <div style={{ maxWidth: '560px', margin: '48px auto', padding: '0 24px' }}>
      {/* Progress indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '40px' }}>
        {steps.map((s, i) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '24px', height: '24px', borderRadius: '50%', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 600,
              fontFamily: 'var(--font-mono)',
              background: i < stepIndex ? '#000' : i === stepIndex ? '#000' : 'var(--sunken)',
              color: i <= stepIndex ? '#fff' : 'var(--ink-faint)',
              border: `1px solid ${i <= stepIndex ? '#000' : 'var(--line)'}`,
            }}>
              {i < stepIndex ? '✓' : i + 1}
            </div>
            <span style={{
              fontSize: '12px', fontFamily: 'var(--font-sans)',
              color: i === stepIndex ? '#000' : 'var(--ink-faint)',
              fontWeight: i === stepIndex ? 600 : 400,
            }}>
              {stepLabel(s)}
            </span>
            {i < steps.length - 1 && (
              <div style={{ width: '24px', height: '1px', background: 'var(--line)' }} />
            )}
          </div>
        ))}
      </div>

      {/* Step: Name */}
      {step === 'name' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>
              Set up your team
            </h2>
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', margin: 0 }}>
              Give your team a name. Teammates will see this when they join.
            </p>
          </div>
          <div>
            <input
              autoFocus
              type="text"
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleCreateTeam(); }}
              placeholder="e.g. Acme Engineering"
              style={{
                width: '100%', boxSizing: 'border-box',
                fontFamily: 'var(--font-sans)', fontSize: '14px',
                padding: '10px 12px', border: '1px solid var(--line)', borderRadius: '4px',
                outline: 'none', background: '#fff',
              }}
            />
          </div>
          {error && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#cc0000', margin: 0 }}>{error}</p>
          )}
          <button
            onClick={() => void handleCreateTeam()}
            disabled={isCreating}
            style={{
              alignSelf: 'flex-start', padding: '10px 20px', cursor: isCreating ? 'default' : 'pointer',
              background: '#000', color: '#fff', border: 'none', borderRadius: '4px',
              fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
              opacity: isCreating ? 0.5 : 1,
            }}
          >
            {isCreating ? 'Creating…' : 'Create Team →'}
          </button>
        </div>
      )}

      {/* Step: Serve */}
      {step === 'serve' && createdTeam && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>
              Start the shared server
            </h2>
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', margin: 0 }}>
              Run this on the machine your team will connect to. Everyone on the team needs to reach this URL.
            </p>
          </div>
          <CodeBlock code="gyst serve --http --port 3456" />
          <div>
            <label style={{ display: 'block', fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--ink-faint)', marginBottom: '6px' }}>
              What URL will teammates use to reach it?
            </label>
            <input
              type="text"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              placeholder="http://localhost:3456"
              style={{
                width: '100%', boxSizing: 'border-box',
                fontFamily: 'var(--font-mono)', fontSize: '12px',
                padding: '10px 12px', border: '1px solid var(--line)', borderRadius: '4px',
                outline: 'none', background: '#fff',
              }}
            />
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', margin: '6px 0 0' }}>
              Localhost works for same-machine teams. For remote teammates, use your public IP or ngrok URL.
            </p>
          </div>
          <button
            onClick={() => setStep('invite')}
            style={{
              alignSelf: 'flex-start', padding: '10px 20px', cursor: 'pointer',
              background: '#000', color: '#fff', border: 'none', borderRadius: '4px',
              fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
            }}
          >
            Continue →
          </button>
        </div>
      )}

      {/* Step: Invite */}
      {step === 'invite' && createdTeam && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>
              Invite your first teammate
            </h2>
            <p style={{ fontFamily: 'var(--font-sans)', fontSize: '13px', color: 'var(--ink-faint)', margin: 0 }}>
              Generate an invite link and share the join command. The invite expires in 7 days.
            </p>
          </div>
          {!inviteCode ? (
            <button
              onClick={() => void handleGenerateInvite()}
              disabled={isGeneratingInvite}
              style={{
                alignSelf: 'flex-start', padding: '10px 20px', cursor: isGeneratingInvite ? 'default' : 'pointer',
                background: '#000', color: '#fff', border: 'none', borderRadius: '4px',
                fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
                opacity: isGeneratingInvite ? 0.5 : 1,
              }}
            >
              {isGeneratingInvite ? 'Generating…' : 'Generate Invite'}
            </button>
          ) : (
            <>
              <div>
                <p style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--ink-faint)', margin: '0 0 6px' }}>
                  Share this command with your teammate:
                </p>
                <CodeBlock code={joinCommand!} />
              </div>
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: '11px', color: 'var(--ink-faint)', margin: 0 }}>
                They run this once in their terminal. Gyst auto-configures all their AI tools.
              </p>
            </>
          )}
          {error && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: '#cc0000', margin: 0 }}>{error}</p>
          )}
          <button
            onClick={() => onComplete(createdTeam)}
            style={{
              alignSelf: 'flex-start', padding: '10px 20px', cursor: 'pointer',
              background: inviteCode ? '#000' : 'transparent',
              color: inviteCode ? '#fff' : 'var(--ink-faint)',
              border: inviteCode ? 'none' : '1px solid var(--line)',
              borderRadius: '4px',
              fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
            }}
          >
            {inviteCode ? 'Open Team Dashboard →' : 'Skip for now'}
          </button>
        </div>
      )}
    </div>
  );
}
