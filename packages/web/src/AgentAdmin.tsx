/**
 * AgentAdmin — Configuration and control UI for the experiment agent.
 * Accessible via ?admin=agent
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSketchByExperimentTask } from './experiments/registry';
import { TASK1_TRIAL_DEFAULTS } from './task1-defaults';

// ---------------------------------------------------------------------------
// Types (mirrored from server/src/agent-rules.ts)
// ---------------------------------------------------------------------------

type DisplayMode =
  | 'all-without-avg'
  | 'all-with-avg-lines'
  | 'all-with-avg-no-lines'
  | 'avgOnly'
  | 'self'
  | 'self-with-avg';
type TaskMode = 'target-tracking' | 'manual-instruction' | 'circle-target-tracking' | 'guide-tracking' | 'random-target-tracking' | 'reaching' | 'shared-single-cursor';

type ExperimentTaskType =
  | 'circle-target-tracking'
  | 'guide-tracking'
  | 'non-guide-tracking'
  | 'group-circle-target-tracking'
  | 'reaching'
  | 'shared-single-cursor-control'
  | 'cursor-control-20260706'
  | 'task8'
  | 'task9';

type ExperimentConfig = {
  taskType: ExperimentTaskType;
  trialCount: number;
  trialDurationSeconds: number;
  waitTimeMinutes: number;
  minParticipants: number;
  instructionDurationMs: number;
  experimentName: string;
  circleTargetPeriod: number;
  circleTargetRadius: number;
  reachingTargetX: number;
  reachingTargetY: number;
  reachingStartX: number;
  reachingStartY: number;
  reachingThreshold: number;
  reachingPreTrials: number;
  reachingRotationTrials: number;
  reachingPostTrials: number;
  reachingRotationDeg: number;
  sharedPracticeTrials: number;
  sharedMainTrials: number;
  sharedSoloTrials: number;
  sharedWait1MinSeconds: number;
  sharedWait1MaxSeconds: number;
  sharedWait2Seconds: number;
  sharedMatrix: [number, number, number, number, number, number, number, number];
  sharedTargetAmplitudes: [number, number, number];
  sharedTargetOmegaX: [number, number, number];
  sharedTargetOmegaY: [number, number, number];
  sharedTargetPhaseX: [number, number, number];
  sharedTargetPhaseY: [number, number, number];
  sharedRandomizePhasesPerTrial: boolean;
  sharedPhaseSeed: number;
  cursorControlBaselineTrials: number;
  cursorControlAdaptationTrials: number;
  cursorControlSharedTrials: number;
  cursorControlWashoutTrials: number;
  cursorControlAdaptationStartGain: number;
  cursorControlAdaptationEndGain: number;
  cursorControlGainTargetA1: number;
  cursorControlGainTargetB1: number;
  cursorControlGainTargetA2: number;
  cursorControlGainTargetB2: number;
  cursorControlGainStepPerTrial: number;
  cursorControlRotationTargetDeg1: number;
  cursorControlRotationTargetDeg2: number;
  cursorControlRotationStepDegPerTrial: number;
  cursorControlRampStartSeconds: number;
  cursorControlRampDurationSeconds: number;
  trialDisplayMode: DisplayMode;
  latencyThresholdMs: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentRule = Record<string, any>;

type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped';

type AgentState = {
  status: AgentStatus;
  currentStepIndex: number;
  rules: AgentRule[];
  error?: string;
  participantCount: number;
  adminConnectionCount?: number;
  manualStartPending?: boolean;
  manualStartRequested?: boolean;
  startedAt?: number;
  config: ExperimentConfig;
  recordingStatus?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultServer = typeof import.meta.env.VITE_TOKEN_SERVER === 'string'
  ? import.meta.env.VITE_TOKEN_SERVER
  : (typeof window !== 'undefined' && window.location.origin
    ? window.location.origin
    : 'http://localhost:3001');

function describeRule(rule: AgentRule): string {
  switch (rule.type) {
    case 'waitForParticipants': {
      const alt = rule.alternatingMessages ? ' (with alternating messages)' : '';
      const phase = rule.waitPhaseTaskMode ? ` [task: ${rule.waitPhaseTaskMode}]` : '';
      const timeout = rule.waitIndefinitely ? 'no timeout' : `timeout: ${rule.timeoutMinutes} min`;
      const manual = rule.waitForAdminStart ? ' [admin start]' : '';
      const cycle =
        rule.targetCycleActiveMs && rule.targetCycleRestMs
          ? ` [cycle: ${rule.targetCycleActiveMs / 1000}s on / ${rule.targetCycleRestMs / 1000}s rest]`
          : '';
      return `Wait for ${rule.minParticipants} participants (${timeout})${phase}${cycle}${manual}${alt}`;
    }
    case 'showInstruction': {
      const extras: string[] = [];
      if (rule.displayMode) extras.push(`mode: ${rule.displayMode}`);
      if (rule.position === 'bottom') extras.push('bottom');
      if (rule.setClickAreaOverlay !== undefined) extras.push(rule.setClickAreaOverlay ? 'show overlay' : 'hide overlay');
      if (rule.setUseVirtualCursor !== undefined) extras.push(rule.setUseVirtualCursor ? 'virtual ON' : 'virtual OFF');
      const suffix = extras.length > 0 ? ` [${extras.join(', ')}]` : '';
      const text = String(rule.text || '');
      return `Instruction: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" (${(rule.durationMs || 0) / 1000}s)${suffix}`;
    }
    case 'setDisplayMode':
      return `Display mode: ${rule.mode}`;
    case 'setTaskMode':
      return `Task mode: ${rule.taskMode}`;
    case 'showYesNoAreas':
      return `Yes/No areas (${rule.requiredArea}, timeout: ${rule.timeoutSeconds}s)`;
    case 'hideYesNoAreas':
      return 'Hide Yes/No areas';
    case 'wait':
      return `Wait ${rule.durationSeconds}s`;
    case 'setCursorVisibility':
      return rule.hideCursor ? 'Hide cursors' : 'Show cursors';
    case 'enableVirtualCursor':
      return `Enable virtual cursor (timeout: ${rule.timeoutSeconds}s)`;
    case 'resetVirtualCursorPosition':
      return 'Reset virtual cursor position';
    case 'setClickAreaOverlay':
      return rule.show ? 'Show click overlay' : 'Hide click overlay';
    case 'startRecording':
      return `Start recording: trial #${rule.trialNumber}`;
    case 'stopRecordingAndUpload':
      return 'Stop recording & upload';
    case 'executeTrial': {
      const rot = rule.cursorRotationDeg ?? 0;
      const rotInfo = rot !== 0 ? `, rot ${rot}°` : '';
      const modeInfo = rule.displayMode ? `, mode=${rule.displayMode}` : '';
      return `Trial ${rule.trialNumber}/${rule.totalTrials} (${rule.durationSeconds}s, ${rule.taskType}${rotInfo}${modeInfo})`;
    }
    case 'computeGroups':
      return rule.groupCount <= 1 ? 'Merge to 1 group' : `Random split into ${rule.groupCount} groups`;
    case 'endSession':
      return 'End session';
    default:
      return rule.type;
  }
}

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: '#6b7280',
  running: '#2563eb',
  completed: '#16a34a',
  error: '#dc2626',
  stopped: '#d97706',
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  completed: 'Completed',
  error: 'Error',
  stopped: 'Stopped',
};

const TASK_TYPE_LABELS: Record<ExperimentTaskType, string> = {
  'circle-target-tracking': 'Circle Target Tracking',
  'guide-tracking': 'Guide Tracking',
  'non-guide-tracking': 'Non-guide Tracking (Free Circular)',
  'group-circle-target-tracking': 'Group Circle Target Tracking',
  'reaching': 'Reaching (Visuomotor Rotation)',
  'shared-single-cursor-control': 'Shared/Single Cursor Control',
  'cursor-control-20260706': 'Joint Cursor 260917',
  'task8': 'Cursor Control 20260724',
  'task9': 'Cursor Control Task9',
};

function randomSharedPhaseSeed(): number {
  return Math.floor(Math.random() * 2147483647) + 1;
}

function isSharedSingleCursorTask(taskType: ExperimentTaskType): boolean {
  return taskType === 'shared-single-cursor-control' || isCursorControlTask(taskType);
}

function isCursorControlTask(taskType: ExperimentTaskType): boolean {
  return taskType === 'cursor-control-20260706' || taskType === 'task8' || taskType === 'task9';
}

// ---------------------------------------------------------------------------
// AgentAdmin Component
// ---------------------------------------------------------------------------

export default function AgentAdmin() {
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const urlPassword = urlParams.get('password') || '';

  const [adminPassword, setAdminPassword] = useState(urlPassword);
  const [authenticated, setAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [agentState, setAgentState] = useState<AgentState>({
    status: 'idle',
    currentStepIndex: -1,
    rules: [],
    participantCount: 0,
    adminConnectionCount: 0,
    config: {
      taskType: 'circle-target-tracking',
      trialCount: 5,
      trialDurationSeconds: 20,
      waitTimeMinutes: 10,
      minParticipants: 10,
      instructionDurationMs: 4000,
      experimentName: '',
      circleTargetPeriod: 5000,
      circleTargetRadius: 0.3,
      reachingTargetX: 0.5,
      reachingTargetY: 0.2,
      reachingStartX: 0.5,
      reachingStartY: 0.8,
      reachingThreshold: 0.05,
      reachingPreTrials: 5,
      reachingRotationTrials: 10,
      reachingPostTrials: 5,
      reachingRotationDeg: 15,
      sharedPracticeTrials: 5,
      sharedMainTrials: 20,
      sharedSoloTrials: 5,
      sharedWait1MinSeconds: 0.8,
      sharedWait1MaxSeconds: 1.2,
      sharedWait2Seconds: 1.5,
      sharedMatrix: [0.5, 0.2, 0.5, -0.2, 0.2, 0.5, -0.2, 0.5],
      sharedTargetAmplitudes: [0.080, 0.055, 0.045],
      sharedTargetOmegaX: [0.90, 1.55, 2.35],
      sharedTargetOmegaY: [0.95, 1.65, 2.20],
      sharedTargetPhaseX: [0, Math.PI / 2, Math.PI],
      sharedTargetPhaseY: [Math.PI / 4, Math.PI, Math.PI / 2],
      sharedRandomizePhasesPerTrial: true,
      sharedPhaseSeed: randomSharedPhaseSeed(),
      ...TASK1_TRIAL_DEFAULTS,
      cursorControlAdaptationTrials: 0,
      cursorControlAdaptationStartGain: 1,
      cursorControlAdaptationEndGain: 1.5,
      cursorControlGainTargetA1: 1,
      cursorControlGainTargetB1: 1,
      cursorControlGainTargetA2: 1,
      cursorControlGainTargetB2: 1,
      cursorControlGainStepPerTrial: 0.1,
      cursorControlRotationTargetDeg1: 0,
      cursorControlRotationTargetDeg2: 0,
      cursorControlRotationStepDegPerTrial: 5,
      cursorControlRampStartSeconds: 5,
      cursorControlRampDurationSeconds: 10,
      trialDisplayMode: 'avgOnly',
      latencyThresholdMs: 100,
    },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [roomName, setRoomName] = useState('joint-cursor-task2');
  const [showRules, setShowRules] = useState(false);
  const pollRef = useRef<number | null>(null);
  const initialLoadDoneRef = useRef(false);

  // Local config editing
  const [localConfig, setLocalConfig] = useState<ExperimentConfig>(agentState.config);

  const baseUrl = defaultServer.replace(/\/$/, '');

  // Fetch agent status
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/agent/status?adminPassword=${encodeURIComponent(adminPassword)}`);
      if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
      const data = await res.json() as AgentState;
      setAgentState(data);
      // Sync localConfig from server only on the first successful load
      if (!initialLoadDoneRef.current && data.config) {
        setLocalConfig(data.config);
        initialLoadDoneRef.current = true;
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, [baseUrl, adminPassword]);

  // Auth on mount
  useEffect(() => {
    if (urlPassword && !authenticated) {
      fetch(`${baseUrl}/agent/status?adminPassword=${encodeURIComponent(urlPassword)}`)
        .then((res) => {
          if (res.ok) {
            setAuthenticated(true);
            setAdminPassword(urlPassword);
          }
          setLoading(false);
        })
        .catch(() => setLoading(false));
    } else if (!urlPassword) {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll
  useEffect(() => {
    if (!authenticated) return;
    fetchStatus();
    pollRef.current = window.setInterval(fetchStatus, 2000);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [fetchStatus, authenticated]);

  // Save config
  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`${baseUrl}/agent/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword, config: localConfig }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Save failed: ${res.status}`);
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  }, [baseUrl, adminPassword, localConfig, fetchStatus]);

  // Start agent
  const startAgent = useCallback(async () => {
    // Save config first, then start
    setSaving(true);
    try {
      // Save config
      const configRes = await fetch(`${baseUrl}/agent/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword, config: localConfig }),
      });
      if (!configRes.ok) {
        const data = await configRes.json().catch(() => ({}));
        throw new Error(data.message || `Config save failed: ${configRes.status}`);
      }

      // Start agent
      const res = await fetch(`${baseUrl}/agent/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminPassword,
          roomName,
          controlOrigin: typeof window !== 'undefined' ? window.location.origin : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Start failed: ${res.status}`);
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start agent');
    } finally {
      setSaving(false);
    }
  }, [baseUrl, adminPassword, roomName, localConfig, fetchStatus]);

  // Stop agent
  const stopAgent = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/agent/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Stop failed: ${res.status}`);
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop agent');
    }
  }, [baseUrl, adminPassword, fetchStatus]);

  // Reset agent
  const resetAgent = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/agent/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Reset failed: ${res.status}`);
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset agent');
    }
  }, [baseUrl, adminPassword, fetchStatus]);

  const manualStartAgent = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/agent/manual-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || `Start failed: ${res.status}`);
      }
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send manual start');
    }
  }, [baseUrl, adminPassword, fetchStatus]);

  const isRunning = agentState.status === 'running';
  const currentRule = isRunning ? agentState.rules[agentState.currentStepIndex] : null;
  const showManualStartButton = Boolean(
    currentRule
      && currentRule.type === 'waitForParticipants'
      && currentRule.waitForAdminStart
      && agentState.participantCount >= (Number(currentRule.minParticipants) || 2)
      && !agentState.manualStartRequested,
  );
  const elapsedSeconds = agentState.startedAt
    ? Math.floor((Date.now() - agentState.startedAt) / 1000)
    : 0;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(`${baseUrl}/agent/status?adminPassword=${encodeURIComponent(passwordInput)}`);
      if (res.ok) {
        setAdminPassword(passwordInput);
        setAuthenticated(true);
      } else {
        setError('Invalid admin password');
      }
    } catch {
      setError('Failed to connect to server');
    }
  };

  if (loading) {
    return (
      <div style={{ fontFamily: 'Inter, system-ui, sans-serif', padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Experiment Agent</h1>
        <p>Loading...</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div style={{ fontFamily: 'Inter, system-ui, sans-serif', padding: '2rem', maxWidth: '400px', margin: '4rem auto' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Experiment Agent</h1>
        <p style={{ color: '#6b7280', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
          Enter the admin password to continue
        </p>
        {error && (
          <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px', marginBottom: '1rem', color: '#dc2626', fontSize: '14px' }}>
            {error}
          </div>
        )}
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder="Admin password"
            autoFocus
            style={{ padding: '8px 12px', fontSize: '14px', borderRadius: '6px', border: '1px solid #d1d5db' }}
          />
          <button
            type="submit"
            disabled={!passwordInput.trim()}
            style={{ padding: '8px 20px', backgroundColor: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', cursor: passwordInput.trim() ? 'pointer' : 'not-allowed', opacity: passwordInput.trim() ? 1 : 0.5, fontSize: '14px', fontWeight: 'bold' }}
          >
            Login
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Experiment Agent</h1>
      <p style={{ color: '#6b7280', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
        Configure experiment parameters and control the automated agent
      </p>

      {error && (
        <div style={{ backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '12px', marginBottom: '1rem', color: '#dc2626', fontSize: '14px' }}>
          {error}
        </div>
      )}

      {/* ── Status Section ─────────────────────────────────────────── */}
      <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Status</h2>
            <span style={{ backgroundColor: STATUS_COLORS[agentState.status], color: '#fff', padding: '3px 10px', borderRadius: '9999px', fontSize: '12px', fontWeight: 'bold' }}>
              {STATUS_LABELS[agentState.status]}
            </span>
            {agentState.recordingStatus && agentState.recordingStatus !== 'idle' && (
              <span style={{ backgroundColor: '#dc2626', color: '#fff', padding: '3px 10px', borderRadius: '9999px', fontSize: '12px', fontWeight: 'bold' }}>
                REC: {agentState.recordingStatus}
              </span>
            )}
          </div>
          <div style={{ fontSize: '14px', color: '#374151' }}>
            Participants: <strong>{agentState.participantCount}</strong>
            <span style={{ marginLeft: '12px' }}>
              Main Admins: <strong>{agentState.adminConnectionCount ?? 0}</strong>
            </span>
          </div>
        </div>

        {(agentState.adminConnectionCount ?? 0) === 0 && (
          <div style={{ backgroundColor: '#fffbeb', border: '1px solid #f59e0b', color: '#92400e', borderRadius: '6px', padding: '10px 12px', fontSize: '13px', marginBottom: '12px', lineHeight: 1.45 }}>
            Warning: no connected main Admin recording client was detected. Open <code>?admin=&lt;ADMIN_PASSWORD&gt;</code> and click <strong>Connect</strong> before starting if you want trial data to upload automatically.
          </div>
        )}

        {isRunning && (
          <div style={{ fontSize: '13px', color: '#374151', marginBottom: '8px' }}>
            Step {agentState.currentStepIndex + 1} / {agentState.rules.length}
            {agentState.rules[agentState.currentStepIndex] && (
              <span style={{ marginLeft: '8px', color: '#2563eb', fontWeight: 500 }}>
                — {describeRule(agentState.rules[agentState.currentStepIndex])}
              </span>
            )}
            {agentState.startedAt && (
              <span style={{ marginLeft: '12px', color: '#6b7280' }}>
                Elapsed: {Math.floor(elapsedSeconds / 60)}m {elapsedSeconds % 60}s
              </span>
            )}
          </div>
        )}

        {agentState.status === 'error' && agentState.error && (
          <div style={{ fontSize: '13px', color: '#dc2626', marginBottom: '8px' }}>Error: {agentState.error}</div>
        )}

        {/* Room name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <label style={{ fontSize: '13px', color: '#374151' }}>Room:</label>
          <input type="text" value={roomName} onChange={(e) => setRoomName(e.target.value)} disabled={isRunning} style={{ padding: '4px 8px', fontSize: '13px', width: '200px' }} />
        </div>

        {/* Control Buttons */}
        <div style={{ display: 'flex', gap: '8px' }}>
          {!isRunning && (
            <button type="button" onClick={startAgent} disabled={saving} style={{ padding: '8px 20px', backgroundColor: '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', cursor: saving ? 'wait' : 'pointer', fontSize: '14px', fontWeight: 'bold' }}>
              {saving ? 'Starting...' : 'Start Agent'}
            </button>
          )}
          {isRunning && (
            <button type="button" onClick={stopAgent} style={{ padding: '8px 20px', backgroundColor: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}>
              Stop Agent
            </button>
          )}
          {showManualStartButton && (
            <button type="button" onClick={manualStartAgent} style={{ padding: '8px 20px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}>
              Start
            </button>
          )}
          {(agentState.status === 'completed' || agentState.status === 'error' || agentState.status === 'stopped') && (
            <button type="button" onClick={resetAgent} style={{ padding: '8px 20px', backgroundColor: '#6b7280', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' }}>
              Reset
            </button>
          )}
        </div>
      </div>

      {/* ── Experiment Config ──────────────────────────────────────── */}
      <div style={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem', margin: '0 0 16px 0' }}>Experiment Configuration</h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          {/* Task Type */}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Task Type</label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {(['circle-target-tracking', 'guide-tracking', 'non-guide-tracking', 'group-circle-target-tracking', 'reaching', 'shared-single-cursor-control', 'cursor-control-20260706', 'task8', 'task9'] as ExperimentTaskType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    // Apply the sketch's declared defaults for this task.
                    // The sketch file (e.g. reaching/sketch.ts) declares
                    // target positions, hit thresholds, phase counts, etc.
                    // here; switching tasks loads those values into the
                    // form. The researcher can still override any field
                    // before clicking Save / Start.
                    const sketchDefaults = getSketchByExperimentTask(t)?.defaults ?? {};
                    const seedDefaults = isSharedSingleCursorTask(t)
                      ? { sharedPhaseSeed: randomSharedPhaseSeed() }
                      : {};
                    setLocalConfig((c) => ({ ...c, taskType: t, ...sketchDefaults, ...seedDefaults }));
                  }}
                  disabled={isRunning}
                  style={{
                    padding: '8px 16px', border: '2px solid', borderRadius: '6px', fontSize: '13px', fontWeight: 600, cursor: isRunning ? 'not-allowed' : 'pointer',
                    borderColor: localConfig.taskType === t ? '#2563eb' : '#d1d5db',
                    backgroundColor: localConfig.taskType === t ? '#eff6ff' : '#fff',
                    color: localConfig.taskType === t ? '#2563eb' : '#374151',
                  }}
                >
                  {TASK_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Experiment Name */}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Experiment Name (optional)</label>
            <input
              type="text"
              value={localConfig.experimentName}
              onChange={(e) => setLocalConfig((c) => ({ ...c, experimentName: e.target.value }))}
              disabled={isRunning}
              placeholder="Auto-generated if empty"
              style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
            />
          </div>

          {/* Shared-cursor tasks use separate Baseline / Shared / Final trial counts. */}
          {!isSharedSingleCursorTask(localConfig.taskType) && (
            <div>
              <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Number of Trials</label>
              <input
                type="number" min={1} max={50}
                value={localConfig.trialCount}
                onChange={(e) => setLocalConfig((c) => ({ ...c, trialCount: parseInt(e.target.value) || 1 }))}
                disabled={isRunning}
                style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
              />
            </div>
          )}

          {/* Trial Duration */}
          <div>
            <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Trial Duration (seconds)</label>
            <input
              type="number" min={4} max={600}
              value={localConfig.trialDurationSeconds}
              onChange={(e) => setLocalConfig((c) => ({ ...c, trialDurationSeconds: parseInt(e.target.value) || 20 }))}
              disabled={isRunning}
              style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
            />
          </div>

          {!isSharedSingleCursorTask(localConfig.taskType) && (
            <>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Wait Time (minutes)</label>
                <input
                  type="number" min={1} max={60}
                  value={localConfig.waitTimeMinutes}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, waitTimeMinutes: parseInt(e.target.value) || 10 }))}
                  disabled={isRunning}
                  style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Min Participants</label>
                <input
                  type="number" min={1} max={100}
                  value={localConfig.minParticipants}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, minParticipants: parseInt(e.target.value) || 10 }))}
                  disabled={isRunning}
                  style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                />
              </div>
            </>
          )}

          {/* Latency Threshold (participant pre-experiment cutoff) */}
          <div>
            <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Latency Threshold (ms)</label>
            <input
              type="number" min={1} max={2000} step={1}
              value={localConfig.latencyThresholdMs}
              onChange={(e) => setLocalConfig((c) => ({ ...c, latencyThresholdMs: parseInt(e.target.value) || 100 }))}
              disabled={isRunning}
              style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
            />
            <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>
              Participants whose median RTT exceeds this cannot enter the experiment. Default 100.
            </div>
          </div>

          {/* Instruction Duration */}
          <div>
            <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Instruction Duration (seconds)</label>
            <input
              type="number" min={1} max={30}
              value={localConfig.instructionDurationMs / 1000}
              onChange={(e) => setLocalConfig((c) => ({ ...c, instructionDurationMs: (parseFloat(e.target.value) || 4) * 1000 }))}
              disabled={isRunning}
              style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
            />
          </div>

          {/* Trial Display Mode — which cursors are visible during trials.
              Applied to every trial; per-trial overrides are possible by editing
              individual `executeTrial` rules under the generated rules viewer. */}
          <div>
            <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Trial Display Mode</label>
            <select
              value={localConfig.trialDisplayMode}
              onChange={(e) => setLocalConfig((c) => ({ ...c, trialDisplayMode: e.target.value as DisplayMode }))}
              disabled={isRunning}
              style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
            >
              <option value="avgOnly">Average Cursor Only</option>
              <option value="self-with-avg">Average + Own Cursor</option>
              <option value="self">Own Cursor Only</option>
              <option value="all-without-avg">All Cursors (no Average)</option>
              <option value="all-with-avg-no-lines">All Cursors + Average</option>
              <option value="all-with-avg-lines">All Cursors + Average (with lines)</option>
            </select>
            <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>
              Cursors visible during each trial. Common instructions auto-adapt to this choice.
            </div>
          </div>

          {/* Circle Target Period (for circle and group-circle) */}
          {(localConfig.taskType === 'circle-target-tracking' || localConfig.taskType === 'group-circle-target-tracking') && (
            <div>
              <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Circle Target Period (ms)</label>
              <input
                type="number" min={1000} max={30000} step={100}
                value={localConfig.circleTargetPeriod}
                onChange={(e) => setLocalConfig((c) => ({ ...c, circleTargetPeriod: parseInt(e.target.value) || 5000 }))}
                disabled={isRunning}
                style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
              />
            </div>
          )}

          {/* Circle Target Radius (for circle, guide, and group-circle) */}
          {(localConfig.taskType === 'circle-target-tracking' || localConfig.taskType === 'guide-tracking' || localConfig.taskType === 'group-circle-target-tracking') && (
            <div>
              <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Circle/Guide Radius (0-0.5)</label>
              <input
                type="number" min={0.05} max={0.5} step={0.01}
                value={localConfig.circleTargetRadius}
                onChange={(e) => setLocalConfig((c) => ({ ...c, circleTargetRadius: parseFloat(e.target.value) || 0.3 }))}
                disabled={isRunning}
                style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
              />
            </div>
          )}

          {/* Reaching task: phase counts + rotation + positions */}
          {localConfig.taskType === 'reaching' && (
            <>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Baseline Trials (no rotation)</label>
                <input
                  type="number" min={0} max={50}
                  value={localConfig.reachingPreTrials}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, reachingPreTrials: parseInt(e.target.value) || 0 }))}
                  disabled={isRunning}
                  style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Rotation Trials</label>
                <input
                  type="number" min={0} max={100}
                  value={localConfig.reachingRotationTrials}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, reachingRotationTrials: parseInt(e.target.value) || 0 }))}
                  disabled={isRunning}
                  style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Washout Trials (no rotation)</label>
                <input
                  type="number" min={0} max={50}
                  value={localConfig.reachingPostTrials}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, reachingPostTrials: parseInt(e.target.value) || 0 }))}
                  disabled={isRunning}
                  style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Rotation Angle (degrees)</label>
                <input
                  type="number" min={-180} max={180} step={1}
                  value={localConfig.reachingRotationDeg}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, reachingRotationDeg: parseFloat(e.target.value) || 0 }))}
                  disabled={isRunning}
                  style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Target Position (x, y)</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="number" min={0} max={1} step={0.01}
                    value={localConfig.reachingTargetX}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, reachingTargetX: parseFloat(e.target.value) || 0 }))}
                    disabled={isRunning}
                    style={{ flex: 1, padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                  />
                  <input
                    type="number" min={0} max={1} step={0.01}
                    value={localConfig.reachingTargetY}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, reachingTargetY: parseFloat(e.target.value) || 0 }))}
                    disabled={isRunning}
                    style={{ flex: 1, padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                  />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Start Position (x, y)</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="number" min={0} max={1} step={0.01}
                    value={localConfig.reachingStartX}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, reachingStartX: parseFloat(e.target.value) || 0 }))}
                    disabled={isRunning}
                    style={{ flex: 1, padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                  />
                  <input
                    type="number" min={0} max={1} step={0.01}
                    value={localConfig.reachingStartY}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, reachingStartY: parseFloat(e.target.value) || 0 }))}
                    disabled={isRunning}
                    style={{ flex: 1, padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                  />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Reach Threshold (stage units)</label>
                <input
                  type="number" min={0.005} max={0.5} step={0.005}
                  value={localConfig.reachingThreshold}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, reachingThreshold: parseFloat(e.target.value) || 0.05 }))}
                  disabled={isRunning}
                  style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                />
              </div>
            </>
          )}

          {isSharedSingleCursorTask(localConfig.taskType) && (
            <>
              {([
                ['Target Amplitudes a1-a3', 'sharedTargetAmplitudes', 0.005],
                ['Target Omega X1-X3', 'sharedTargetOmegaX', 0.1],
                ['Target Omega Y1-Y3', 'sharedTargetOmegaY', 0.1],
                ['Target Phase X1-X3', 'sharedTargetPhaseX', 0.01],
                ['Target Phase Y1-Y3', 'sharedTargetPhaseY', 0.01],
              ] as const).map(([label, key, step]) => (
                <div key={key}>
                  <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>{label}</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px' }}>
                    {localConfig[key].map((value, index) => (
                      <input
                        key={index}
                        type="number"
                        step={step}
                        value={value}
                        onChange={(e) => {
                          const next = [...localConfig[key]] as [number, number, number];
                          next[index] = parseFloat(e.target.value) || 0;
                          setLocalConfig((c) => ({ ...c, [key]: next }));
                        }}
                        disabled={isRunning}
                        style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    const randomPhase = (): number => {
                      const u = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, Math.random()));
                      return u * Math.PI * 2 - Math.PI;
                    };
                    const randomTriple = (): [number, number, number] => [
                      randomPhase(),
                      randomPhase(),
                      randomPhase(),
                    ];
                    setLocalConfig((c) => ({
                      ...c,
                      sharedTargetPhaseX: randomTriple(),
                      sharedTargetPhaseY: randomTriple(),
                    }));
                  }}
                  disabled={isRunning}
                  style={{
                    padding: '7px 12px',
                    backgroundColor: '#2563eb',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                    fontSize: '13px',
                    fontWeight: 600,
                  }}
                >
                  Generate Fixed Phases
                </button>
                <span style={{ fontSize: '12px', color: '#6b7280' }}>
                  Generates six fixed values in radians from -pi to +pi (exclusive) and writes them into Phase X/Y.
                </span>
              </div>
              <div style={{ gridColumn: '1 / -1', padding: '10px', border: '1px solid #dbeafe', borderRadius: '6px', backgroundColor: '#eff6ff' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#1e3a8a', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={localConfig.sharedRandomizePhasesPerTrial}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, sharedRandomizePhasesPerTrial: e.target.checked }))}
                    disabled={isRunning}
                  />
                  Randomize phases per trial using seed
                </label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    step={1}
                    value={localConfig.sharedPhaseSeed}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, sharedPhaseSeed: parseInt(e.target.value) || 1 }))}
                    disabled={isRunning}
                    style={{ width: '180px', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #93c5fd' }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setLocalConfig((c) => ({
                        ...c,
                        sharedRandomizePhasesPerTrial: true,
                        sharedPhaseSeed: Math.floor(Math.random() * 2147483647) + 1,
                      }));
                    }}
                    disabled={isRunning}
                    style={{
                      padding: '7px 12px',
                      backgroundColor: '#1d4ed8',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: isRunning ? 'not-allowed' : 'pointer',
                      fontSize: '13px',
                      fontWeight: 600,
                    }}
                  >
                    Generate Per-Trial Phase Seed
                  </button>
                  <span style={{ fontSize: '12px', color: '#1e40af' }}>
                    Uses seed + trial number to generate six phases per trial in (-pi, pi) without displaying a 6 x N matrix.
                  </span>
                </div>
              </div>
              {isCursorControlTask(localConfig.taskType) ? (
                <>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Baseline / Adaptation / Shared / Washout Trials</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '6px' }}>
                      <input type="number" min={0} max={100} value={localConfig.cursorControlBaselineTrials} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlBaselineTrials: parseInt(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" min={0} max={100} value={localConfig.cursorControlAdaptationTrials} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlAdaptationTrials: parseInt(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" min={0} max={100} value={localConfig.cursorControlSharedTrials} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlSharedTrials: parseInt(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" min={0} max={100} value={localConfig.cursorControlWashoutTrials} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlWashoutTrials: parseInt(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                    </div>
                    <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                      Participants are told this is Baseline → Shared → Baseline; adaptation/washout labels are for the researcher only.
                    </div>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>
                      {localConfig.taskType === 'task8'
                        ? 'Gain Disturbance Targets: P1 x/y, P2 x/y'
                        : 'Gain Disturbance Targets: P1 a/b, P2 a/b'}
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '6px' }}>
                      <input type="number" min={0} step={0.01} value={localConfig.cursorControlGainTargetA1} onChange={(e) => { const v = parseFloat(e.target.value); setLocalConfig((c) => ({ ...c, cursorControlGainTargetA1: Number.isFinite(v) ? v : 1 })); }} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" min={0} step={0.01} value={localConfig.cursorControlGainTargetB1} onChange={(e) => { const v = parseFloat(e.target.value); setLocalConfig((c) => ({ ...c, cursorControlGainTargetB1: Number.isFinite(v) ? v : 1 })); }} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" min={0} step={0.01} value={localConfig.cursorControlGainTargetA2} onChange={(e) => { const v = parseFloat(e.target.value); setLocalConfig((c) => ({ ...c, cursorControlGainTargetA2: Number.isFinite(v) ? v : 1 })); }} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" min={0} step={0.01} value={localConfig.cursorControlGainTargetB2} onChange={(e) => { const v = parseFloat(e.target.value); setLocalConfig((c) => ({ ...c, cursorControlGainTargetB2: Number.isFinite(v) ? v : 1 })); }} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                    </div>
                    <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
                      {localConfig.taskType === 'task8'
                        ? 'x scales horizontal motion; y scales vertical motion. Defaults are all 1.'
                        : 'a scales motion along y=x; b scales motion along y=-x. Defaults are all 1.'}
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Gain Step / Adaptation Trial</label>
                    <input type="number" min={0} step={0.01} value={localConfig.cursorControlGainStepPerTrial} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlGainStepPerTrial: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Rotation Targets P1/P2 (deg)</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' }}>
                      <input type="number" step={1} value={localConfig.cursorControlRotationTargetDeg1} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlRotationTargetDeg1: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" step={1} value={localConfig.cursorControlRotationTargetDeg2} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlRotationTargetDeg2: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Rotation Step / Adaptation Trial (deg)</label>
                    <input type="number" min={0} step={1} value={localConfig.cursorControlRotationStepDegPerTrial} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlRotationStepDegPerTrial: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Within-Trial Ramp Start / Duration (s)</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px' }}>
                      <input type="number" min={0} step={0.1} value={localConfig.cursorControlRampStartSeconds} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlRampStartSeconds: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                      <input type="number" min={0} step={0.1} value={localConfig.cursorControlRampDurationSeconds} onChange={(e) => setLocalConfig((c) => ({ ...c, cursorControlRampDurationSeconds: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                    </div>
                  </div>
                </>
              ) : (
                <div>
                  <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Baseline / Shared / Final Trials</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input type="number" min={0} max={50} value={localConfig.sharedPracticeTrials} onChange={(e) => setLocalConfig((c) => ({ ...c, sharedPracticeTrials: parseInt(e.target.value) || 0 }))} disabled={isRunning} style={{ flex: 1, padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                    <input type="number" min={0} max={100} value={localConfig.sharedMainTrials} onChange={(e) => setLocalConfig((c) => ({ ...c, sharedMainTrials: parseInt(e.target.value) || 0 }))} disabled={isRunning} style={{ flex: 1, padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                    <input type="number" min={0} max={50} value={localConfig.sharedSoloTrials} onChange={(e) => setLocalConfig((c) => ({ ...c, sharedSoloTrials: parseInt(e.target.value) || 0 }))} disabled={isRunning} style={{ flex: 1, padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                  </div>
                </div>
              )}
              {!isCursorControlTask(localConfig.taskType) && (
                <div>
                  <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Shared Cursor Matrix A (2 x 4)</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '6px' }}>
                    {localConfig.sharedMatrix.map((value, index) => (
                      <input
                        key={index}
                        type="number"
                        step={0.01}
                        value={value}
                        onChange={(e) => {
                          const next = [...localConfig.sharedMatrix] as ExperimentConfig['sharedMatrix'];
                          next[index] = parseFloat(e.target.value) || 0;
                          setLocalConfig((c) => ({ ...c, sharedMatrix: next }));
                        }}
                        disabled={isRunning}
                        style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }}
                      />
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label style={{ display: 'block', fontSize: '13px', color: '#374151', marginBottom: '4px', fontWeight: 600 }}>Wait1 Min/Max, Wait2</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px' }}>
                  <input type="number" min={0} step={0.1} value={localConfig.sharedWait1MinSeconds} onChange={(e) => setLocalConfig((c) => ({ ...c, sharedWait1MinSeconds: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                  <input type="number" min={0} step={0.1} value={localConfig.sharedWait1MaxSeconds} onChange={(e) => setLocalConfig((c) => ({ ...c, sharedWait1MaxSeconds: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                  <input type="number" min={0} step={0.5} value={localConfig.sharedWait2Seconds} onChange={(e) => setLocalConfig((c) => ({ ...c, sharedWait2Seconds: parseFloat(e.target.value) || 0 }))} disabled={isRunning} style={{ width: '100%', padding: '6px 8px', fontSize: '13px', borderRadius: '4px', border: '1px solid #d1d5db' }} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Save button */}
        {!isRunning && (
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={saveConfig}
              disabled={saving}
              style={{ padding: '6px 16px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: saving ? 'wait' : 'pointer', fontSize: '13px', fontWeight: 'bold' }}
            >
              {saving ? 'Saving...' : 'Save Config'}
            </button>
          </div>
        )}

        {/* Summary */}
        <div style={{ marginTop: '16px', padding: '12px', backgroundColor: '#f0fdf4', borderRadius: '6px', border: '1px solid #bbf7d0', fontSize: '13px', color: '#166534' }}>
          {localConfig.taskType === 'group-circle-target-tracking' ? (
            <>
              <strong>Summary:</strong> {TASK_TYPE_LABELS[localConfig.taskType]} — {localConfig.trialCount} trials × 3 phases = <strong>{localConfig.trialCount * 3}</strong> total trials × {localConfig.trialDurationSeconds}s
              (split → re-shuffle → merge). Wait up to {localConfig.waitTimeMinutes} min for {localConfig.minParticipants} participants.
            </>
          ) : localConfig.taskType === 'reaching' ? (
            <>
              <strong>Summary:</strong> {TASK_TYPE_LABELS[localConfig.taskType]} — {localConfig.reachingPreTrials} baseline + {localConfig.reachingRotationTrials} rotation ({localConfig.reachingRotationDeg}°) + {localConfig.reachingPostTrials} washout = <strong>{localConfig.reachingPreTrials + localConfig.reachingRotationTrials + localConfig.reachingPostTrials}</strong> trials.
              Each trial ends when avg cursor reaches the target (max {localConfig.trialDurationSeconds}s).
              Target ({localConfig.reachingTargetX}, {localConfig.reachingTargetY}) → start ({localConfig.reachingStartX}, {localConfig.reachingStartY}).
              Wait up to {localConfig.waitTimeMinutes} min for {localConfig.minParticipants} participants.
            </>
          ) : isCursorControlTask(localConfig.taskType) ? (
            <>
              <strong>Summary:</strong> {TASK_TYPE_LABELS[localConfig.taskType]} - {localConfig.cursorControlBaselineTrials} baseline + {localConfig.cursorControlAdaptationTrials} adaptation + {localConfig.cursorControlSharedTrials} shared + {localConfig.cursorControlWashoutTrials} washout = <strong>{localConfig.cursorControlBaselineTrials + localConfig.cursorControlAdaptationTrials + localConfig.cursorControlSharedTrials + localConfig.cursorControlWashoutTrials}</strong> total trials x {localConfig.trialDurationSeconds}s.
              Adaptation ramps within each trial from {localConfig.cursorControlRampStartSeconds}s for {localConfig.cursorControlRampDurationSeconds}s; shared holds the final gain/rotation targets. Participants are told the public flow is Baseline → Shared → Baseline.
            </>
          ) : isSharedSingleCursorTask(localConfig.taskType) ? (
            <>
              <strong>Summary:</strong> {TASK_TYPE_LABELS[localConfig.taskType]} - {localConfig.sharedPracticeTrials} baseline + {localConfig.sharedMainTrials} shared + {localConfig.sharedSoloTrials} final = <strong>{localConfig.sharedPracticeTrials + localConfig.sharedMainTrials + localConfig.sharedSoloTrials}</strong> total trials x {localConfig.trialDurationSeconds}s.
              Requires exactly two participants and waits until both are connected.
            </>
          ) : (
            <>
              <strong>Summary:</strong> {TASK_TYPE_LABELS[localConfig.taskType]} — {localConfig.trialCount} trials x {localConfig.trialDurationSeconds}s
              (target visible: {Math.floor(localConfig.trialDurationSeconds / 2)}s, hidden: {Math.ceil(localConfig.trialDurationSeconds / 2)}s)
              — Wait up to {localConfig.waitTimeMinutes} min for {localConfig.minParticipants} participants
            </>
          )}
        </div>
      </div>

      {/* ── Generated Rules (collapsible) ─────────────────────────── */}
      <div style={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.1rem', margin: 0 }}>
            Generated Rules ({agentState.rules.length} steps)
          </h2>
          <button
            type="button"
            onClick={() => setShowRules(!showRules)}
            style={{ padding: '4px 12px', fontSize: '12px', background: '#e5e7eb', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            {showRules ? 'Hide' : 'Show'}
          </button>
        </div>

        {showRules && (
          <div style={{ marginTop: '12px', maxHeight: '400px', overflowY: 'auto' }}>
            {agentState.rules.length === 0 ? (
              <div style={{ padding: '16px', textAlign: 'center', color: '#9ca3af', fontSize: '13px' }}>
                No rules generated. Save config to generate rules.
              </div>
            ) : (
              agentState.rules.map((rule, index) => {
                const isCurrent = isRunning && index === agentState.currentStepIndex;
                const isPast = isRunning && index < agentState.currentStepIndex;
                return (
                  <div
                    key={index}
                    style={{
                      padding: '8px 12px',
                      marginBottom: '4px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      border: isCurrent ? '2px solid #2563eb' : '1px solid #e5e7eb',
                      backgroundColor: isCurrent ? '#eff6ff' : isPast ? '#f0fdf4' : '#fff',
                      color: isPast ? '#6b7280' : '#374151',
                    }}
                  >
                    <span style={{ fontWeight: 'bold', marginRight: '8px', color: isCurrent ? '#2563eb' : '#9ca3af' }}>
                      #{index + 1}
                    </span>
                    {isCurrent && (
                      <span style={{ backgroundColor: '#2563eb', color: '#fff', padding: '1px 6px', borderRadius: '9999px', fontSize: '10px', fontWeight: 'bold', marginRight: '6px' }}>
                        CURRENT
                      </span>
                    )}
                    {describeRule(rule)}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
