import { useCallback, useEffect, useRef, useState } from 'react';
import {
  POINT_TO_POINT_ADMIN_DEFAULTS,
  type PointToPointAdminConfig,
  shouldSyncAgentConfigFromStatus,
} from './admin-agent-controls-config-sync';

type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped';

type Props = {
  baseUrl: string;
  adminPassword: string;
  roomName: string;
  connected: boolean;
  showSharedCursorFeedback: boolean;
  onShowSharedCursorFeedbackChange: (show: boolean) => void;
};

type AgentState = {
  status: AgentStatus;
  currentStepIndex: number;
  rules?: Array<{ type?: string; trialNumber?: number; totalTrials?: number }>;
  participantCount: number;
  adminConnectionCount?: number;
  error?: string;
  config?: { trialCount?: number; trialDurationSeconds?: number; waitTimeMinutes?: number; minParticipants?: number; instructionDurationMs?: number; experimentName?: string };
  terminationOutcomes?: Array<{
    identity: string;
    disposition: 'return-no-payment' | 'partner-compensation-review';
    reason: string;
    elapsedSeconds: number;
  }>;
  prolificRecovery?: {
    status: 'idle' | 'pausing' | 'waiting-for-release' | 'restarting' | 'paused-after-start' | 'error';
    identity?: string;
    submissionStatus?: string;
    activeCount?: number;
    reservedCount?: number;
    error?: string;
  };
  prolificAutomationConfigured?: boolean;
};

const statusColor: Record<AgentStatus, string> = {
  idle: '#6b7280', running: '#2563eb', completed: '#16a34a', error: '#dc2626', stopped: '#d97706',
};

export default function AdminAgentControls({
  baseUrl,
  adminPassword,
  roomName,
  connected,
  showSharedCursorFeedback,
  onShowSharedCursorFeedbackChange,
}: Props) {
  const [state, setState] = useState<AgentState>({ status: 'idle', currentStepIndex: -1, participantCount: 0 });
  const [config, setConfig] = useState<PointToPointAdminConfig>({
    ...POINT_TO_POINT_ADMIN_DEFAULTS,
  });
  const initialConfigLoadedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const api = baseUrl.replace(/\/$/, '');

  const refresh = useCallback(async () => {
    if (!adminPassword) return;
    const response = await fetch(`${api}/agent/status?adminPassword=${encodeURIComponent(adminPassword)}`);
    if (!response.ok) throw new Error(`Agent status: ${response.status}`);
    const next = await response.json() as AgentState;
    setState(next);
    if (next.config && shouldSyncAgentConfigFromStatus(initialConfigLoadedRef.current, next.status)) {
      setConfig((current) => ({ ...current, ...next.config }));
      initialConfigLoadedRef.current = true;
    }
  }, [api, adminPassword]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Agent status unavailable'));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const request = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword, ...body }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(data.message || `Agent request failed: ${response.status}`);
    }
  };

  const saveAndStart = async () => {
    setBusy(true); setMessage(null);
    try {
      await request('/agent/config', {
        config: {
          ...config,
          taskType: 'task9',
        },
      });
      await request('/agent/start', { roomName, controlOrigin: window.location.origin });
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Agent start failed'); }
    finally { setBusy(false); }
  };

  const stop = async () => { setBusy(true); setMessage(null); try { await request('/agent/stop', {}); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Agent stop failed'); } finally { setBusy(false); } };
  const reset = async () => { setBusy(true); setMessage(null); try { await request('/agent/reset', {}); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Agent reset failed'); } finally { setBusy(false); } };
  const currentRule = state.rules?.[state.currentStepIndex];
  const currentTrial = currentRule?.type === 'executeTrial' && typeof currentRule.trialNumber === 'number'
    ? `${currentRule.trialNumber}/${currentRule.totalTrials ?? '?'}`
    : '—';
  const field = (key: keyof typeof config, label: string, type: 'text' | 'number' = 'number') => (
    <label style={{ display: 'block', fontSize: '0.75rem', color: '#374151' }}>{label}
      <input type={type} value={config[key]} onChange={(event) => setConfig({ ...config, [key]: type === 'number' ? Number(event.target.value) : event.target.value })} disabled={busy || state.status === 'running'} style={{ display: 'block', width: '100%', marginTop: '0.2rem', padding: '0.35rem', boxSizing: 'border-box' }} />
    </label>
  );

  return <div className="ctrl-section" style={{ borderColor: '#2563eb' }}>
    <h4>Automated Experiment</h4>
    <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
      Status: <strong style={{ color: statusColor[state.status] }}>{state.status}</strong> · Trial: <strong>{currentTrial}</strong> · Participants: {state.participantCount} · Admins: {state.adminConnectionCount ?? 0}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.4rem' }}>
      {field('cursorControlBaselineTrials', 'Baseline trials')}
      {field('cursorControlSharedTrials', 'Shared trials')}
      {field('cursorControlWashoutTrials', 'Washout trials')}
      {field('trialDurationSeconds', 'Trial seconds')}
      {field('instructionDurationMs', 'Instruction ms')}
    </div>
    <label style={{ display: 'flex', gap: '0.45rem', alignItems: 'flex-start', marginTop: '0.6rem', fontSize: '0.75rem', color: '#374151' }}>
      <input
        type="checkbox"
        checked={showSharedCursorFeedback}
        onChange={(event) => onShowSharedCursorFeedbackChange(event.target.checked)}
        disabled={!connected}
      />
      <span>Show individual cursors and connecting line during shared trials</span>
    </label>
    {message && <div style={{ color: '#b91c1c', fontSize: '0.75rem', marginTop: '0.4rem' }}>{message}</div>}
    {state.error && <div style={{ color: '#b91c1c', fontSize: '0.75rem', marginTop: '0.4rem' }}>{state.error}</div>}
    {state.prolificAutomationConfigured === false && (
      <div style={{ color: '#b45309', fontSize: '0.72rem', marginTop: '0.4rem' }}>
        Prolific auto-recruitment is disabled: configure PROLIFIC_API_TOKEN on the server.
      </div>
    )}
    {(state.terminationOutcomes?.length ?? 0) > 0 && (
      <div style={{ marginTop: '0.5rem', padding: '0.5rem', border: '1px solid #f59e0b', borderRadius: '0.4rem', background: '#fffbeb', fontSize: '0.72rem' }}>
        <strong>Prolific follow-up required</strong>
        {state.terminationOutcomes?.map((outcome) => (
          <div key={outcome.identity} style={{ marginTop: '0.35rem', overflowWrap: 'anywhere' }}>
            <div>{outcome.identity}</div>
            <div>
              {outcome.disposition === 'return-no-payment'
                ? 'Return / no standard reward'
                : 'Return + review partial/full compensation'}
              {' · '}{Math.max(1, Math.ceil(outcome.elapsedSeconds / 60))} min
            </div>
          </div>
        ))}
      </div>
    )}
    {state.prolificRecovery && state.prolificRecovery.status !== 'idle' && (
      <div style={{ marginTop: '0.5rem', padding: '0.5rem', border: '1px solid #2563eb', borderRadius: '0.4rem', background: '#eff6ff', fontSize: '0.72rem' }}>
        <strong>Prolific recruitment recovery: {state.prolificRecovery.status}</strong>
        {state.prolificRecovery.identity && <div>Participant: {state.prolificRecovery.identity}</div>}
        {state.prolificRecovery.submissionStatus && <div>Submission: {state.prolificRecovery.submissionStatus}</div>}
        {(state.prolificRecovery.activeCount !== undefined || state.prolificRecovery.reservedCount !== undefined) && (
          <div>Active: {state.prolificRecovery.activeCount ?? 0} · Reserved: {state.prolificRecovery.reservedCount ?? 0}</div>
        )}
        {state.prolificRecovery.error && <div style={{ color: '#b91c1c' }}>{state.prolificRecovery.error}</div>}
      </div>
    )}
    <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
      <button type="button" onClick={saveAndStart} disabled={!connected || busy || state.status === 'running'} style={{ flex: 1 }}>Enable Auto Start</button>
      <button type="button" onClick={stop} disabled={busy || state.status !== 'running'}>Stop</button>
      <button type="button" onClick={reset} disabled={busy || state.status === 'running'}>Reset</button>
    </div>
  </div>;
}
