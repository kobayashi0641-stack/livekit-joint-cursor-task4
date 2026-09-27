/**
 * Experiment Agent — automates experiment flow by executing rules sequentially.
 *
 * Uses RoomServiceClient to:
 *   - listParticipants(): monitor participant count
 *   - sendData(): send control/broadcast messages to the room
 */

import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import type {
  AgentRule,
  AgentState,
  AgentStatus,
  DisplayMode,
  ExperimentConfig,
  ExperimentTaskType,
} from './agent-rules.js';
import {
  DEFAULT_EXPERIMENT_CONFIG,
  isCursorControlExperimentTask,
  isSharedSingleCursorExperimentTask,
  randomSharedPhaseSeed,
} from './agent-rules.js';
import {
  DEFAULT_RULES,
  generateRulesFromConfig,
  getTask,
} from './experiments/index.js';
import type { TrialContext } from './experiments/types.js';
import {
  buildNoMatchTerminationOutcome,
  buildParticipantTerminationOutcomes,
  buildStartTimeoutTerminationOutcomes,
  hasParticipantStartTimedOut,
  type ParticipantTerminationOutcome,
} from './participant-outcomes.js';
import {
  isJoinableProlificSubmissionStatus,
  recoverProlificStudy,
  recoverProlificStudySubmissions,
  type ProlificGateway,
} from './prolific-recovery.js';
import {
  disconnectCompletedParticipant,
  scheduleEndSessionParticipantCleanup,
} from './end-session-cleanup.js';
import { formatInterTrialUploadMessage } from './inter-trial-message.js';

const CONTROL_TOPIC = 'control';
const BROADCAST_TOPIC = 'broadcast';
const TARGET_TOPIC = 'target';
const COMPLETION_URL = 'https://app.prolific.com/submissions/complete?cc=CFL5QARB';
const INTER_TRIAL_MESSAGE_DURATION_MS = 60_000;

class PairedSessionRecoveredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairedSessionRecoveredError';
  }
}

class PairedSessionStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairedSessionStoppedError';
  }
}

type YesNoAreasState = {
  visible: boolean;
  yesPosition: { x: number; y: number };
  noPosition: { x: number; y: number };
};

type ProlificSession = {
  studyId: string;
  submissionId: string;
};

type ProlificRecoveryState = NonNullable<AgentState['prolificRecovery']>;

function isSyntheticParticipantIdentity(identity: string): boolean {
  return identity.startsWith('sim-bot-')
    || identity.startsWith('sim-participant-')
    || identity.startsWith('debug-')
    || identity.startsWith('werewolf:')
    || identity.startsWith('latency-');
}

function getParticipantRole(metadata?: string): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { role?: unknown };
    return typeof parsed.role === 'string' ? parsed.role : null;
  } catch {
    return null;
  }
}

function isExperimentParticipant(participant: { identity: string; metadata?: string }): boolean {
  const role = getParticipantRole(participant.metadata);
  return !participant.identity.startsWith('admin:')
    && (
      role === 'experiment-participant'
      || (role === null && !isSyntheticParticipantIdentity(participant.identity))
    );
}

function isAdminConnection(participant: { identity: string; metadata?: string }): boolean {
  return participant.identity.startsWith('admin:');
}

/** Cursor area report from a participant */
export type AreaReport = {
  identity: string;
  area: 'yes' | 'no' | null;
  timestamp: number;
};

/** Virtual cursor status report from a participant */
export type VirtualCursorReport = {
  identity: string;
  isPointerLocked: boolean;
  timestamp: number;
};

/** Average cursor position report from the admin client */
export type AvgCursorReport = {
  x: number;
  y: number;
  timestamp: number;
};

/**
 * Sketch event posted by an admin client (via POST /agent/sketch-event)
 * when its sketch's `hit.detect` predicate returns true. The agent's
 * `waitForSketchEvent(name, ...)` resolves when a matching name arrives.
 */
export type SketchEventReport = {
  name: string;
  data?: unknown;
  timestamp: number;
};

export type CursorReadinessReport = {
  identity: string;
  x: number;
  y: number;
  timestamp: number;
};

export type SharedCursorResponseReport = {
  identity: string;
  trialNumber: number;
  questionnaireKind: 'legacy' | 'contribution';
  agency?: number;
  partnership?: number;
  contribution?: number;
  timestamp: number;
};

export type SharedTrackingCompletionReport = {
  identity: string;
  trialKey: string;
  timestamp: number;
};

export type InstructionNextReport = {
  identity: string;
  instructionId: string;
  timestamp: number;
};

function recordingUploadKey(experimentName: string, trialNumber: number): string {
  return `${experimentName}::${trialNumber}`;
}

export class ExperimentAgent {
  private roomService: RoomServiceClient;
  private roomName: string;
  private rules: AgentRule[];
  private currentStepIndex: number;
  private status: AgentStatus;
  private error?: string;
  private participantCount: number;
  private adminConnectionCount: number;
  private startedAt?: number;
  private abortController: AbortController | null;
  private areaReports: Map<string, AreaReport>;
  private virtualCursorReports: Map<string, VirtualCursorReport>;
  private listeners: Array<() => void>;
  private config: ExperimentConfig;
  private _recordingStatus: 'idle' | 'recording' | 'queued' | 'uploading' | 'uploaded' | 'error';
  private _recordingUploads: Map<string, 'recording' | 'queued' | 'uploading' | 'uploaded' | 'error'>;
  private _activeRecording: { experimentName: string; trialNumber: number } | null;
  private previousYesPosition: { x: number; y: number } | null;
  private _avgCursorReport: AvgCursorReport | null;
  private _cursorReadiness: Map<string, CursorReadinessReport[]>;
  private _participantStartReports: Map<string, number>;
  private _pairedParticipantIdentities: string[];
  private _terminationOutcomes: ParticipantTerminationOutcome[];
  private _prolificSessions: Map<string, ProlificSession>;
  private _prolificRecovery: ProlificRecoveryState;
  private prolificGateway: ProlificGateway | null;
  /**
   * Avg-cursor coordinate-frame offset used by tasks like `reaching`. The
   * displayed avg cursor on every client is `rawAvg - _avgCursorOffset`. Set
   * at trial start by `applyAvgCursorOffset(initialX, initialY)` so that
   * `displayed = initial` at calibration time and moves with rawAvg afterwards.
   */
  private _avgCursorOffset: { x: number; y: number };
  /**
   * Inbox for sketch events posted by admin clients via
   * POST /agent/sketch-event. Keyed by event name. `waitForSketchEvent`
   * clears the entry on consume so subsequent waits start fresh, and on
   * entry to a wait it clears any stale entry so cross-trial leakage
   * cannot fire a hit before the wait actually starts.
   */
  private _sketchEventInbox: Map<string, SketchEventReport>;
  private _sharedCursorResponses: Map<number, Map<string, SharedCursorResponseReport>>;
  private _sharedTrackingCompletions: Map<string, Map<string, SharedTrackingCompletionReport>>;
  private _instructionNextReports: Map<string, Map<string, InstructionNextReport>>;
  private _sharedDisconnectHandled: boolean;
  private _manualStartPending: boolean;
  private _manualStartRequested: boolean;
  private _restartRequested: boolean;
  private _pausedProlificStudyId: string | null;
  private controlOrigin: string | null;

  constructor(
    roomService: RoomServiceClient,
    roomName: string = 'joint-cursor-task2',
    prolificGateway: ProlificGateway | null = null,
  ) {
    this.roomService = roomService;
    this.roomName = roomName;
    this.config = { ...DEFAULT_EXPERIMENT_CONFIG };
    this.rules = [...DEFAULT_RULES];
    this.currentStepIndex = -1;
    this.status = 'idle';
    this.participantCount = 0;
    this.adminConnectionCount = 0;
    this.abortController = null;
    this.areaReports = new Map();
    this.virtualCursorReports = new Map();
    this.listeners = [];
    this._recordingStatus = 'idle';
    this._recordingUploads = new Map();
    this._activeRecording = null;
    this.previousYesPosition = null;
    this._avgCursorReport = null;
    this._cursorReadiness = new Map();
    this._participantStartReports = new Map();
    this._pairedParticipantIdentities = [];
    this._terminationOutcomes = [];
    this._prolificSessions = new Map();
    this._prolificRecovery = { status: 'idle' };
    this.prolificGateway = prolificGateway;
    this._avgCursorOffset = { x: 0, y: 0 };
    this._sketchEventInbox = new Map();
    this._sharedCursorResponses = new Map();
    this._sharedTrackingCompletions = new Map();
    this._instructionNextReports = new Map();
    this._sharedDisconnectHandled = false;
    this._manualStartPending = false;
    this._manualStartRequested = false;
    this._restartRequested = false;
    this._pausedProlificStudyId = null;
    this.controlOrigin = null;
  }

  // ── Listeners ──────────────────────────────────────────────────────────

  onStateChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* ignore */ }
    }
  }

  // ── State ──────────────────────────────────────────────────────────────

  getState(): AgentState {
    return {
      status: this.status,
      currentStepIndex: this.currentStepIndex,
      rules: this.rules,
      error: this.error,
      participantCount: this.participantCount,
      adminConnectionCount: this.adminConnectionCount,
      manualStartPending: this._manualStartPending,
      manualStartRequested: this._manualStartRequested,
      startedAt: this.startedAt,
      config: { ...this.config },
      recordingStatus: this._recordingStatus,
      terminationOutcomes: [...this._terminationOutcomes],
      prolificRecovery: { ...this._prolificRecovery },
      prolificAutomationConfigured: this.prolificGateway !== null,
    };
  }

  async refreshParticipantCount(): Promise<number> {
    await this.refreshRoomConnectionCounts();
    return this.participantCount;
  }

  // ── Config ─────────────────────────────────────────────────────────────

  getConfig(): ExperimentConfig {
    return { ...this.config };
  }

  setConfig(config: ExperimentConfig): void {
    if (this.status === 'running') {
      throw new Error('Cannot update config while agent is running');
    }
    this.config = { ...DEFAULT_EXPERIMENT_CONFIG, ...config };
    this.rules = generateRulesFromConfig(this.config);
    this.notifyListeners();
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  setRules(rules: AgentRule[]): void {
    if (this.status === 'running') {
      throw new Error('Cannot update rules while agent is running');
    }
    this.rules = [...rules];
    this.notifyListeners();
  }

  setRoomName(roomName: string): void {
    this.roomName = roomName;
  }

  setControlOrigin(origin: string | null): void {
    this.controlOrigin = origin;
  }

  // ── Reports ────────────────────────────────────────────────────────────

  reportArea(report: AreaReport): void {
    this.areaReports.set(report.identity, report);
  }

  reportVirtualCursor(report: VirtualCursorReport): void {
    this.virtualCursorReports.set(report.identity, report);
  }

  reportRecordingStatus(
    status: 'idle' | 'recording' | 'queued' | 'uploading' | 'uploaded' | 'error',
    experimentName: string,
    trialNumber: number,
  ): void {
    const key = recordingUploadKey(experimentName, trialNumber);
    if (status !== 'idle') {
      const previous = this._recordingUploads.get(key);
      const rank = { recording: 0, queued: 1, uploading: 2, uploaded: 3, error: 3 } as const;
      if (!previous || rank[status] >= rank[previous]) {
        this._recordingUploads.set(key, status);
      }
    }
    const activeKey = this._activeRecording
      ? recordingUploadKey(this._activeRecording.experimentName, this._activeRecording.trialNumber)
      : null;
    if (!activeKey || activeKey === key) {
      this._recordingStatus = status;
    }
    console.log(`[Agent] Recording status updated: ${status} (${experimentName} trial #${trialNumber})`);
  }

  reportAvgCursor(report: AvgCursorReport): void {
    this._avgCursorReport = report;
  }

  reportCursorReadiness(reports: CursorReadinessReport[]): void {
    const now = Date.now();
    for (const report of reports) {
      if (!Number.isFinite(report.x) || !Number.isFinite(report.y)) continue;
      const history = this._cursorReadiness.get(report.identity) ?? [];
      history.push({ ...report, timestamp: report.timestamp || now });
      this._cursorReadiness.set(report.identity, history.filter((entry) => now - entry.timestamp <= 2000).slice(-30));
    }
  }

  async reportParticipantStart(identity: string): Promise<boolean> {
    const currentRule = this.rules[this.currentStepIndex];
    if (
      this.status !== 'running'
      || currentRule?.type !== 'waitForParticipants'
      || currentRule.waitForParticipantStart !== true
    ) {
      console.warn(`[Agent] Ignored START confirmation outside the participant START gate: ${identity}`);
      return false;
    }

    const connectedIdentities = await this.getExperimentParticipantIdentities();
    if (!connectedIdentities.includes(identity)) {
      console.warn(`[Agent] Ignored START confirmation from a disconnected or unknown participant: ${identity}`);
      return false;
    }

    this._participantStartReports.set(identity, Date.now());
    console.log(`[Agent] START confirmed by ${identity}.`);
    return true;
  }

  /**
   * Confirm a participant START press, bootstrapping the point-to-point task when the operator
   * has the recording admin open but has not manually started the agent.
   */
  async confirmParticipantStart(identity: string): Promise<boolean> {
    const connectedIdentities = await this.getExperimentParticipantIdentities();
    if (!connectedIdentities.includes(identity)) {
      console.warn(`[Agent] Ignored START confirmation from a disconnected or unknown participant: ${identity}`);
      return false;
    }

    if (this.status === 'idle') {
      await this.refreshRoomConnectionCounts();
      if (this.participantCount < 2) {
        throw new Error('Both participants must be connected before START can be confirmed.');
      }
      if (this.adminConnectionCount < 1) {
        throw new Error('The experiment admin is not connected. Please wait and try again.');
      }

      this.setConfig({
        ...this.config,
        taskType: 'task9',
        minParticipants: 2,
        cursorControlAdaptationTrials: 0,
      });
      console.log('[Agent] Participant START triggered automatic point-to-point startup.');
      void this.start().catch((error) => {
        console.error('[Agent] Automatic point-to-point startup failed:', error);
      });
    } else if (this.config.taskType !== 'task9') {
      throw new Error('A different experiment is currently running.');
    }

    // Record the click immediately. Agent startup is asynchronous and can
    // take several seconds while room state is initialized; waiting for the
    // gate here made a valid first click time out and forced the participant
    // to press START again. start() has already cleared stale reports before
    // reaching this line, so this confirmation belongs to the new pair.
    this._participantStartReports.set(identity, Date.now());
    console.log(`[Agent] START confirmed by ${identity}.`);
    return true;
  }

  private async waitForParticipantStartGate(timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const currentRule = this.rules[this.currentStepIndex];
      if (
        this.status === 'running'
        && currentRule?.type === 'waitForParticipants'
        && currentRule.waitForParticipantStart === true
      ) {
        return;
      }
      if (this.status === 'error') {
        throw new Error(this.error ?? 'The experiment could not be started.');
      }
      if (this.status !== 'running') {
        throw new Error('The experiment is not available for START confirmation.');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The experiment did not become ready for START confirmation in time.');
  }

  async disconnectParticipantAfterCompletion(identity: string): Promise<boolean> {
    return disconnectCompletedParticipant({
      roomService: this.roomService,
      roomName: this.roomName,
      identity,
      completedParticipantIdentities: this._pairedParticipantIdentities,
    });
  }

  async registerProlificSession(identity: string, studyId: string, submissionId: string): Promise<void> {
    if (!this.prolificGateway) {
      throw new Error('PROLIFIC_API_TOKEN is not configured');
    }
    const details = await this.prolificGateway.getSubmissionDetails(submissionId);
    if (details.studyId !== studyId || details.participantId !== identity) {
      throw new Error('Prolific submission identifiers do not match the connected participant');
    }
    if (!isJoinableProlificSubmissionStatus(details.status)) {
      throw new Error(`Prolific submission is not joinable (status: ${details.status})`);
    }
    this._prolificSessions.set(identity, { studyId, submissionId });
    console.log(`[Agent] Registered Prolific session for ${identity}`);

    const recoveryInProgress = this._prolificRecovery.status === 'pausing'
      || this._prolificRecovery.status === 'waiting-for-release'
      || this._prolificRecovery.status === 'restarting';
    if (!recoveryInProgress) return;

    const recoveryStudyIds = [...this._prolificSessions.entries()]
      .filter(([registeredIdentity]) => registeredIdentity !== identity)
      .map(([, session]) => session.studyId);
    if (recoveryStudyIds.length > 0 && !recoveryStudyIds.includes(studyId)) {
      await this.roomService.removeParticipant(this.roomName, identity).catch(() => {});
      this._prolificSessions.delete(identity);
      throw new Error('The paired experiment is recovering a different Prolific study');
    }

    const outcome = buildNoMatchTerminationOutcome(identity, 0);
    this._terminationOutcomes = [...this._terminationOutcomes, outcome];
    await this.sendToParticipants(CONTROL_TOPIC, {
      type: 'participantTermination',
      disposition: outcome.disposition,
      reason: outcome.reason,
      elapsedSeconds: outcome.elapsedSeconds,
      timestamp: Date.now(),
    }, [identity]).catch(() => {});
    this.notifyListeners();

    let returnRequested = false;
    try {
      await this.prolificGateway.requestReturn(submissionId, [
        'The paired experiment was already recovering because a participant was unavailable.',
      ]);
      returnRequested = true;
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      await this.roomService.removeParticipant(this.roomName, identity).catch(() => {});
      if (returnRequested) this._prolificSessions.delete(identity);
    }
    console.log(`[Agent] Late participant ${identity} was returned and disconnected during Prolific recovery.`);
  }

  /**
   * Receive a sketch event from an admin client. Stores the most recent
   * report per event name; `waitForSketchEvent` consumes the entry on
   * match. Multiple admins reporting the same event will overwrite each
   * other — the most recent fire wins, which is the desired behavior
   * (the leader admin's hit decision overrides earlier stale reports).
   */
  reportSketchEvent(name: string, data?: unknown): void {
    const report: SketchEventReport = { name, data, timestamp: Date.now() };
    this._sketchEventInbox.set(name, report);
    console.log(`[Agent] Sketch event received: '${name}'`);
  }

  reportSharedCursorResponse(report: SharedCursorResponseReport): void {
    const byTrial = this._sharedCursorResponses.get(report.trialNumber) ?? new Map();
    byTrial.set(report.identity, report);
    this._sharedCursorResponses.set(report.trialNumber, byTrial);
    console.log(
      `[Agent] Shared cursor response: trial=${report.trialNumber}, identity=${report.identity}, ` +
      (report.questionnaireKind === 'contribution'
        ? `contribution=${report.contribution}`
        : `agency=${report.agency}, partnership=${report.partnership}`),
    );
  }

  reportSharedTrackingCompletion(report: SharedTrackingCompletionReport): void {
    const byIdentity = this._sharedTrackingCompletions.get(report.trialKey) ?? new Map();
    byIdentity.set(report.identity, report);
    this._sharedTrackingCompletions.set(report.trialKey, byIdentity);
    console.log(`[Agent] Shared tracking completed: trialKey=${report.trialKey}, identity=${report.identity}`);
  }

  reportInstructionNext(report: InstructionNextReport): void {
    const byIdentity = this._instructionNextReports.get(report.instructionId) ?? new Map();
    byIdentity.set(report.identity, report);
    this._instructionNextReports.set(report.instructionId, byIdentity);
    console.log(`[Agent] Instruction Next: instructionId=${report.instructionId}, identity=${report.identity}`);
  }

  async reportParticipantWithdraw(identity: string, reason: string): Promise<void> {
    if (this.status !== 'running') return;
    if (!isSharedSingleCursorExperimentTask(this.config.taskType)) return;
    if (this._sharedDisconnectHandled) return;
    const signal = this.abortController?.signal;
    if (!signal || signal.aborted) return;

    console.warn(`[Agent] Participant withdrawal reported: identity=${identity}, reason=${reason}`);
    try {
      const stage = reason === 'participant inactivity timeout' ? 'inactivity timeout' : 'withdrawal';
      await this.handleSharedParticipantDisconnect(stage, 1, 2, signal, identity, reason);
    } catch (err) {
      if (err instanceof PairedSessionRecoveredError || err instanceof PairedSessionStoppedError) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.status = 'error';
      this.abortController?.abort();
      this.notifyListeners();
    }
  }

  requestManualStart(): void {
    this._manualStartRequested = true;
    this._manualStartPending = false;
    console.log('[Agent] Manual start requested by admin.');
    this.notifyListeners();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.status === 'running') {
      throw new Error('Agent is already running');
    }
    if (this.rules.length === 0) {
      throw new Error('No rules configured');
    }

    this.refreshSharedPhaseSeedForExperimentPair();

    this.status = 'running';
    this.currentStepIndex = 0;
    this.error = undefined;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
    this.areaReports.clear();
    this.virtualCursorReports.clear();
    this._recordingStatus = 'idle';
    this._recordingUploads.clear();
    this._activeRecording = null;
    this.previousYesPosition = null;
    this._avgCursorReport = null;
    this._avgCursorOffset = { x: 0, y: 0 };
    this._sketchEventInbox.clear();
    this._sharedCursorResponses.clear();
    this._sharedTrackingCompletions.clear();
    this._instructionNextReports.clear();
    this._participantStartReports.clear();
    this._pairedParticipantIdentities = [];
    this._terminationOutcomes = [];
    this._prolificRecovery = { status: 'idle' };
    this._sharedDisconnectHandled = false;
    this._manualStartPending = false;
    this._manualStartRequested = false;
    this._restartRequested = false;
    this._pausedProlificStudyId = null;
    this.notifyListeners();

    while (this.status === 'running') {
      const signal = this.abortController.signal;
      try {
        await this.executeRules(signal);
      } catch (err) {
        if (
          !(err instanceof PairedSessionRecoveredError && this._restartRequested)
          && !(err instanceof PairedSessionStoppedError)
        ) {
          if (this.status === 'running') {
            this.status = 'error';
            this.error = err instanceof Error ? err.message : String(err);
            this.notifyListeners();
          }
          return;
        }
      }

      if (this._restartRequested && this.status === 'running') {
        this.prepareForRecoveredSessionRestart();
        continue;
      }
      if (this.status === 'running') {
        this.status = 'completed';
        this.notifyListeners();
      }
      return;
    }
  }

  private prepareForRecoveredSessionRestart(): void {
    this.refreshSharedPhaseSeedForExperimentPair();
    this.abortController = new AbortController();
    this.currentStepIndex = 0;
    this.error = undefined;
    this.startedAt = Date.now();
    this.participantCount = 0;
    this.areaReports.clear();
    this.virtualCursorReports.clear();
    this._recordingStatus = 'idle';
    this._recordingUploads = new Map();
    this._activeRecording = null;
    this.previousYesPosition = null;
    this._avgCursorReport = null;
    this._avgCursorOffset = { x: 0, y: 0 };
    this._cursorReadiness.clear();
    this._sketchEventInbox.clear();
    this._sharedCursorResponses.clear();
    this._sharedTrackingCompletions.clear();
    this._instructionNextReports.clear();
    this._participantStartReports.clear();
    this._pairedParticipantIdentities = [];
    this._prolificRecovery = { status: 'idle' };
    this._sharedDisconnectHandled = false;
    this._manualStartPending = false;
    this._manualStartRequested = false;
    this._restartRequested = false;
    this._pausedProlificStudyId = null;
    console.log('[Agent] Previous paired session recovered. Waiting for a new pair.');
    this.notifyListeners();
  }

  private refreshSharedPhaseSeedForExperimentPair(): void {
    if (
      !isSharedSingleCursorExperimentTask(this.config.taskType)
      || !this.config.sharedRandomizePhasesPerTrial
    ) {
      return;
    }
    this.config = {
      ...this.config,
      sharedPhaseSeed: randomSharedPhaseSeed(),
    };
    console.log(`[Agent] Target trajectory phase seed refreshed for experiment pair: ${this.config.sharedPhaseSeed}`);
  }

  stop(): void {
    if (this.status !== 'running') return;
    this.abortController?.abort();
    this.abortController = null;
    this.status = 'stopped';
    this.notifyListeners();
  }

  reset(): void {
    this.stop();
    this.status = 'idle';
    this.currentStepIndex = -1;
    this.error = undefined;
    this.startedAt = undefined;
    this.areaReports.clear();
    this.virtualCursorReports.clear();
    this._recordingStatus = 'idle';
    this._recordingUploads.clear();
    this._activeRecording = null;
    this.previousYesPosition = null;
    this._avgCursorReport = null;
    this._avgCursorOffset = { x: 0, y: 0 };
    this._sketchEventInbox.clear();
    this._participantStartReports.clear();
    this._pairedParticipantIdentities = [];
    this._terminationOutcomes = [];
    this._prolificRecovery = { status: 'idle' };
    this._sharedDisconnectHandled = false;
    this._manualStartPending = false;
    this._manualStartRequested = false;
    this._restartRequested = false;
    this._pausedProlificStudyId = null;
    this.notifyListeners();
  }

  // ─── Rule execution ────────────────────────────────────────────────────

  private async executeRules(signal: AbortSignal): Promise<void> {
    for (let i = 0; i < this.rules.length; i++) {
      if (signal.aborted) return;
      this.currentStepIndex = i;
      this.notifyListeners();

      const rule = this.rules[i];
      console.log(`[Agent] Executing step ${i + 1}/${this.rules.length}: ${rule.type}`);

      await this.executeRule(rule, signal);
    }
  }

  private async executeRule(rule: AgentRule, signal: AbortSignal): Promise<void> {
    switch (rule.type) {
      case 'waitForParticipants':
        await this.execWaitForParticipants(rule, signal);
        break;
      case 'showInstruction':
        await this.execShowInstruction(rule, signal);
        break;
      case 'setDisplayMode':
        await this.execSetDisplayMode(rule.mode, signal);
        break;
      case 'setTaskMode':
        await this.execSetTaskMode(rule.taskMode, signal);
        break;
      case 'showYesNoAreas':
        await this.execShowYesNoAreas(rule.requiredArea, rule.requiredRatio, rule.timeoutSeconds, signal);
        break;
      case 'hideYesNoAreas':
        await this.execHideYesNoAreas(signal);
        break;
      case 'wait':
        await this.execWait(rule.durationSeconds, signal);
        break;
      case 'setCursorVisibility':
        await this.execSetCursorVisibility(rule.hideCursor, signal);
        break;
      case 'enableVirtualCursor':
        await this.execEnableVirtualCursor(rule.timeoutSeconds, signal);
        break;
      case 'resetVirtualCursorPosition':
        await this.execResetVirtualCursorPosition(signal);
        break;
      case 'setClickAreaOverlay':
        await this.execSetClickAreaOverlay(rule.show, signal);
        break;
      case 'startRecording':
        await this.execStartRecording(
          rule.experimentName,
          rule.trialNumber,
          this.config.taskType,
          this.config.trialDisplayMode ?? 'avgOnly',
          this.participantCount,
          signal,
        );
        break;
      case 'stopRecordingAndUpload':
        await this.execStopRecordingAndUpload(rule.timeoutSeconds, signal);
        break;
      case 'executeTrial':
        await this.execExecuteTrial(rule, signal);
        break;
      case 'computeGroups':
        await this.execComputeGroups(rule.groupCount, signal);
        break;
      case 'endSession':
        await this.execEndSession(rule.completionUrl, signal);
        break;
    }
  }

  // ─── Individual rule executors ─────────────────────────────────────────

  private async execWaitForParticipants(
    rule: {
      minParticipants: number;
      timeoutMinutes: number;
      waitPhaseDisplayMode?: DisplayMode;
      waitPhaseTaskMode?: string;
      waitPhaseHideCursor?: boolean;
      showCountdown?: boolean;
      waitIndefinitely?: boolean;
      endOnTimeout?: boolean;
      waitForAdminStart?: boolean;
      waitForParticipantStart?: boolean;
      participantStartTimeoutSeconds?: number;
      alternatingMessages?: { messages: string[]; intervalMs: number };
      targetCycleActiveMs?: number;
      targetCycleRestMs?: number;
      restMessage?: string;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const timeoutMs = rule.timeoutMinutes * 60 * 1000;
    let safetyWindowStartedAt = Date.now();
    const showCountdown = rule.showCountdown !== false;

    if (isSharedSingleCursorExperimentTask(this.config.taskType)) {
      await this.removeSyntheticParticipantsForSharedTask();
    }

    // Set up wait-phase environment
    if (rule.waitPhaseDisplayMode) {
      await this.execSetDisplayMode(rule.waitPhaseDisplayMode, signal);
    }
    if (rule.waitPhaseTaskMode) {
      await this.execSetTaskMode(rule.waitPhaseTaskMode, signal);
    }
    if (rule.waitPhaseHideCursor !== undefined) {
      await this.execSetCursorVisibility(rule.waitPhaseHideCursor, signal);
    }

    // Alternating instructions
    let msgIndex = 0;
    let lastMsgTime = 0;
    const altMsgs = rule.alternatingMessages;

    // Target publishing
    let lastTargetTime = 0;
    const TARGET_UPDATE_INTERVAL = 2000;

    // Target on/off cycle. Active phase shows the target; rest phase hides it
    // and swaps the bottom message. Enabled only when both durations are set
    // AND the wait-phase task mode actually displays targets.
    const cyclingEnabled =
      rule.waitPhaseTaskMode === 'target-tracking' &&
      !!rule.targetCycleActiveMs &&
      !!rule.targetCycleRestMs;
    const cycleActiveMs = rule.targetCycleActiveMs ?? 0;
    const cycleRestMs = rule.targetCycleRestMs ?? 0;
    const restMessage =
      rule.restMessage ?? 'Please rest your hand briefly. The targets will reappear in a moment.';
    let cyclePhase: 'active' | 'rest' = 'active';
    let cyclePhaseStart = Date.now();
    if (cyclingEnabled) {
      // Ensure target is visible at the start of the first active phase.
      await this.setTargetVisibility(true);
      console.log(
        `[Agent] Wait phase: target cycle enabled (${cycleActiveMs / 1000}s active / ${cycleRestMs / 1000}s rest)`,
      );
    }

    // Countdown timer — starts when first participant joins
    let firstParticipantJoinedAt: number | null = null;
    let participantStartWindowStartedAt: number | null = null;
    let participantStartWindowIdentities: string[] = [];
    let lastCountdownTime = 0;
    const COUNTDOWN_INTERVAL = 1000; // update every 1s for smooth display

    while (!signal.aborted) {
      const now = Date.now();

      // Check participant count first (needed for countdown)
      const count = await this.getParticipantCount();
      this.participantCount = count;
      this.notifyListeners();

      // Detect first participant — start timer from this moment
      if (firstParticipantJoinedAt === null && count > 0) {
        firstParticipantJoinedAt = now;
        console.log('[Agent] First participant joined. Countdown timer started.');
      }

      // Cycle phase transition (independent of countdown / participant gating)
      if (cyclingEnabled) {
        const phaseElapsed = now - cyclePhaseStart;
        if (cyclePhase === 'active' && phaseElapsed >= cycleActiveMs) {
          cyclePhase = 'rest';
          cyclePhaseStart = now;
          await this.setTargetVisibility(false);
          lastMsgTime = 0; // force immediate rest-message broadcast below
          console.log(`[Agent] Wait phase: entering rest period (${cycleRestMs / 1000}s)`);
        } else if (cyclePhase === 'rest' && phaseElapsed >= cycleRestMs) {
          cyclePhase = 'active';
          cyclePhaseStart = now;
          // Publish a fresh target *before* re-enabling visibility so the
          // client renders the new position (not the stale one from before
          // the rest period) the moment the target reappears.
          await this.sendToRoom(TARGET_TOPIC, {
            type: 'target' as const,
            x: 0.1 + Math.random() * 0.8,
            y: 0.1 + Math.random() * 0.8,
            shape: 'triangle' as const,
            timestamp: now,
          }).catch(() => {});
          lastTargetTime = now;
          await this.setTargetVisibility(true);
          lastMsgTime = 0; // force immediate active-message broadcast below
          console.log(`[Agent] Wait phase: entering active period (${cycleActiveMs / 1000}s)`);
        }
      }

      // Publish bottom message: rest text during rest phase, alternating
      // messages otherwise. The alternating rotation pauses across rest so
      // participants don't lose their place in the sequence.
      if (altMsgs && now - lastMsgTime >= altMsgs.intervalMs) {
        let text: string;
        if (cyclingEnabled && cyclePhase === 'rest') {
          text = restMessage;
        } else {
          text = altMsgs.messages[msgIndex % altMsgs.messages.length];
          msgIndex++;
        }
        await this.sendToRoom(BROADCAST_TOPIC, {
          type: 'broadcast' as const,
          text,
          durationMs: altMsgs.intervalMs,
          severity: 'info' as const,
          position: 'bottom' as const,
          timestamp: now,
        }).catch(() => {});
        lastMsgTime = now;
      }

      // Countdown timer (center) — only after first participant joins
      if (showCountdown && firstParticipantJoinedAt !== null && now - lastCountdownTime >= COUNTDOWN_INTERVAL) {
        const elapsedSinceJoin = now - firstParticipantJoinedAt;
        const remainingMs = Math.max(0, timeoutMs - elapsedSinceJoin);
        const remainingMin = Math.floor(remainingMs / 60000);
        const remainingSec = Math.floor((remainingMs % 60000) / 1000);
        const countdownText = `${remainingMin}:${remainingSec.toString().padStart(2, '0')}\n${count} / ${rule.minParticipants} participants`;
        await this.sendToRoom(BROADCAST_TOPIC, {
          type: 'broadcast' as const,
          text: countdownText,
          durationMs: COUNTDOWN_INTERVAL + 1500, // overlap to prevent flicker
          severity: 'info' as const,
          position: 'center' as const,
          timestamp: now,
        }).catch(() => {});
        lastCountdownTime = now;
      }

      // Publish target positions if target-tracking mode AND in active phase.
      // During rest phase, suspend publishing so the last target doesn't
      // bounce around behind the hidden flag.
      if (
        rule.waitPhaseTaskMode === 'target-tracking' &&
        (!cyclingEnabled || cyclePhase === 'active') &&
        now - lastTargetTime >= TARGET_UPDATE_INTERVAL
      ) {
        await this.sendToRoom(TARGET_TOPIC, {
          type: 'target' as const,
          x: 0.1 + Math.random() * 0.8,
          y: 0.1 + Math.random() * 0.8,
          shape: 'triangle' as const,
          timestamp: now,
        }).catch(() => {});
        lastTargetTime = now;
      }

      // Enough participants → proceed
      if (count >= rule.minParticipants) {
        if (rule.waitForParticipantStart) {
          const identities = (await this.getExperimentParticipantIdentities())
            .sort((left, right) => left.localeCompare(right))
            .slice(0, rule.minParticipants);
          const participantSetChanged = identities.length !== participantStartWindowIdentities.length
            || identities.some((identity, index) => identity !== participantStartWindowIdentities[index]);
          if (participantStartWindowStartedAt === null || participantSetChanged) {
            participantStartWindowStartedAt = now;
            participantStartWindowIdentities = [...identities];
            for (const reportedIdentity of [...this._participantStartReports.keys()]) {
              if (!identities.includes(reportedIdentity)) this._participantStartReports.delete(reportedIdentity);
            }
            console.log(`[Agent] START confirmation window opened for ${identities.length} participants.`);
          }
          const allPressed = identities.length >= rule.minParticipants
            && identities.every((identity) => this._participantStartReports.has(identity));
          if (!allPressed) {
            const timeoutSeconds = rule.participantStartTimeoutSeconds ?? 120;
            if (
              identities.length >= rule.minParticipants
              && hasParticipantStartTimedOut(participantStartWindowStartedAt, now, timeoutSeconds)
            ) {
              const recovered = await this.handleParticipantStartTimeout(
                identities,
                participantStartWindowStartedAt,
                signal,
              );
              if (!recovered) return;
              firstParticipantJoinedAt = null;
              participantStartWindowStartedAt = null;
              participantStartWindowIdentities = [];
              safetyWindowStartedAt = Date.now();
              this.participantCount = 0;
              this.notifyListeners();
              continue;
            }
            await this.sleep(250, signal);
            continue;
          }
          this._pairedParticipantIdentities = [...identities];
          await this.pauseProlificStudyAfterStart(identities);
          console.log('[Agent] All participants pressed START. Proceeding to instructions.');
          return;
        }
        if (rule.waitForAdminStart && !this._manualStartRequested) {
          if (!this._manualStartPending) {
            this._manualStartPending = true;
            console.log(`[Agent] ${count} participants joined. Waiting for admin Start.`);
            this.notifyListeners();
          }
          await this.sleep(1000, signal);
          continue;
        }
        if (rule.waitForAdminStart) {
          this._manualStartPending = false;
          this._manualStartRequested = false;
        }
        console.log(`[Agent] ${count} participants joined (target: ${rule.minParticipants}). Proceeding.`);
        return;
      }

      participantStartWindowStartedAt = null;
      participantStartWindowIdentities = [];

      // Timeout from first participant join
      if (!rule.waitIndefinitely && firstParticipantJoinedAt !== null && (now - firstParticipantJoinedAt) >= timeoutMs) {
        if (rule.endOnTimeout && count < rule.minParticipants) {
          const waitingIdentities = await this.getExperimentParticipantIdentities().catch(() => [] as string[]);
          const waitingIdentity = waitingIdentities[0];
          if (waitingIdentity) {
            const outcome = buildNoMatchTerminationOutcome(
              waitingIdentity,
              (now - firstParticipantJoinedAt) / 1000,
            );
            this._terminationOutcomes = [outcome];
            await this.sendToParticipants(CONTROL_TOPIC, {
              type: 'participantTermination',
              disposition: outcome.disposition,
              reason: outcome.reason,
              elapsedSeconds: outcome.elapsedSeconds,
              timestamp: now,
            }, [waitingIdentity]).catch(() => {});
          }
          const prolificSession = waitingIdentity
            ? this._prolificSessions.get(waitingIdentity)
            : undefined;
          if (!waitingIdentity || !prolificSession || !this.prolificGateway) {
            const missing = !this.prolificGateway
              ? 'PROLIFIC_API_TOKEN is not configured'
              : 'STUDY_ID or SESSION_ID was not registered for the waiting participant';
            this.error = `Prolific auto-recruitment stopped safely: ${missing}.`;
            this._prolificRecovery = { status: 'error', identity: waitingIdentity, error: this.error };
            this.status = 'stopped';
            this.abortController?.abort();
            this.notifyListeners();
            return;
          }

          this._prolificRecovery = { status: 'pausing', identity: waitingIdentity };
          this.notifyListeners();
          try {
            await recoverProlificStudy({
              gateway: this.prolificGateway,
              studyId: prolificSession.studyId,
              submissionId: prolificSession.submissionId,
              signal,
              onReturnRequested: async () => {
                await this.sleep(1000, signal);
                await this.roomService.removeParticipant(this.roomName, waitingIdentity).catch(() => {});
              },
              onProgress: (submissionStatus, counts) => {
                this._prolificRecovery = {
                  status: 'waiting-for-release',
                  identity: waitingIdentity,
                  submissionStatus,
                  activeCount: counts.ACTIVE ?? 0,
                  reservedCount: counts.RESERVED ?? 0,
                };
                this.notifyListeners();
              },
            });
          } catch (err) {
            this.error = err instanceof Error ? err.message : String(err);
            this._prolificRecovery = {
              status: 'error',
              identity: waitingIdentity,
              error: this.error,
            };
            this.status = 'stopped';
            this.abortController?.abort();
            this.notifyListeners();
            return;
          }

          this._prolificRecovery = { status: 'idle' };
          this._prolificSessions.delete(waitingIdentity);
          this._participantStartReports.delete(waitingIdentity);
          firstParticipantJoinedAt = null;
          safetyWindowStartedAt = Date.now();
          this.participantCount = 0;
          this.notifyListeners();
          continue;
        }
        console.log(`[Agent] Timeout reached (${rule.timeoutMinutes} min from first join). Proceeding with ${count} participants.`);
        return;
      }

      // Absolute safety timeout (2x wait time from agent start, even if no one joins)
      if (!rule.waitIndefinitely && now - safetyWindowStartedAt >= timeoutMs * 2) {
        console.log(`[Agent] Absolute timeout. Proceeding with ${count} participants.`);
        return;
      }

      await this.sleep(1000, signal);
    }
  }

  private async execShowInstruction(
    rule: {
      text: string;
      durationMs: number;
      broadcastDurationMs?: number;
      waitForDuration: boolean;
      instructionPages?: string[];
      waitForNext?: boolean;
      nextButtonLabel?: string;
      nextMinDisplayMs?: number;
      displayMode?: DisplayMode;
      hideCursor?: boolean;
      position?: 'center' | 'bottom';
      setClickAreaOverlay?: boolean;
      setUseVirtualCursor?: boolean;
      unlockPointerLock?: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    await this.setTargetVisibility(false);

    // Apply display mode change
    if (rule.displayMode !== undefined) {
      await this.execSetDisplayMode(rule.displayMode, signal);
    }

    // Apply cursor visibility change
    if (rule.hideCursor !== undefined) {
      await this.execSetCursorVisibility(rule.hideCursor, signal);
    }

    // Apply click area overlay
    if (rule.setClickAreaOverlay !== undefined) {
      await this.execSetClickAreaOverlay(rule.setClickAreaOverlay, signal);
    }

    // Apply virtual cursor mode
    if (rule.setUseVirtualCursor !== undefined) {
      if (signal.aborted) return;
      await this.sendToRoom(CONTROL_TOPIC, {
        type: 'setUseVirtualCursor' as const,
        useVirtualCursor: rule.setUseVirtualCursor,
        timestamp: Date.now(),
      });
      console.log(`[Agent] Virtual cursor: ${rule.setUseVirtualCursor ? 'ON' : 'OFF'}`);
    }

    if (rule.unlockPointerLock) {
      await this.unlockPointerLock();
    }

    // Send broadcast message. The client-visible lifetime (`durationMs` on the
    // payload) defaults to the read time, but `wrapInstructionWithYesNo`
    // overrides it via `broadcastDurationMs` so the instruction text remains
    // on screen across the immediately following Yes/No confirmation phase.
    // The agent's own sleep below is still bound to `rule.durationMs` (read
    // time), so experiment pacing is unchanged.
    const instructionId = rule.waitForNext ? `instruction-${Date.now()}-${Math.random().toString(36).slice(2)}` : undefined;
    const nextMinDisplayMs = rule.nextMinDisplayMs ?? 1000;
    if (instructionId) {
      this._instructionNextReports.delete(instructionId);
    }
    const broadcastDurationMs = rule.broadcastDurationMs ?? (rule.waitForNext ? 60 * 60 * 1000 : rule.durationMs);
    const message = {
      type: 'broadcast' as const,
      text: rule.text,
      instructionPages: rule.instructionPages,
      durationMs: broadcastDurationMs,
      severity: 'info' as const,
      position: (rule.position || 'center') as 'center' | 'bottom',
      instructionId,
      waitForNext: rule.waitForNext,
      nextButtonLabel: rule.nextButtonLabel,
      nextMinDisplayMs,
      timestamp: Date.now(),
    };

    await this.sendToRoom(BROADCAST_TOPIC, message);
    console.log(`[Agent] Broadcast (${rule.position || 'center'}): "${rule.text.substring(0, 60)}..." (read ${rule.durationMs}ms / visible ${broadcastDurationMs}ms)`);

    if (rule.waitForDuration) {
      await this.sleep(rule.durationMs, signal);
    }
    if (rule.waitForNext && instructionId) {
      await this.sleep(nextMinDisplayMs, signal);
      await this.waitForInstructionNext(instructionId, signal);
    }
  }

  private async handleParticipantStartTimeout(
    identities: string[],
    startedAt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    this._terminationOutcomes = buildStartTimeoutTerminationOutcomes({
      participantIdentities: identities,
      elapsedSeconds: (Date.now() - startedAt) / 1000,
    });
    for (const outcome of this._terminationOutcomes) {
      await this.sendToParticipants(CONTROL_TOPIC, {
        type: 'participantTermination',
        disposition: outcome.disposition,
        reason: outcome.reason,
        elapsedSeconds: outcome.elapsedSeconds,
        timestamp: Date.now(),
      }, [outcome.identity]).catch(() => {});
    }
    this.notifyListeners();

    const sessions = identities.map((identity) => ({
      identity,
      session: this._prolificSessions.get(identity),
    }));
    const studyIds = [...new Set(sessions.map(({ session }) => session?.studyId).filter(Boolean))];
    const missingSession = sessions.find(({ session }) => !session);
    if (!this.prolificGateway || missingSession || studyIds.length !== 1) {
      const missing = !this.prolificGateway
        ? 'PROLIFIC_API_TOKEN is not configured'
        : missingSession
          ? `STUDY_ID or SESSION_ID was not registered for ${missingSession.identity}`
          : 'participants were registered under different Prolific studies';
      this.error = `START-timeout recovery stopped safely: ${missing}.`;
      this._prolificRecovery = { status: 'error', identity: identities.join(', '), error: this.error };
      this.status = 'stopped';
      this.abortController?.abort();
      this.notifyListeners();
      return false;
    }

    const studyId = studyIds[0] as string;
    const submissionIds = sessions.map(({ session }) => session!.submissionId);
    this._prolificRecovery = { status: 'pausing', identity: identities.join(', ') };
    this.notifyListeners();
    try {
      await recoverProlificStudySubmissions({
        gateway: this.prolificGateway,
        studyId,
        submissionIds,
        returnReason: 'The paired experiment could not start because both participants did not confirm START within two minutes.',
        signal,
        onReturnRequested: async () => {
          await this.sleep(1000, signal);
          await Promise.all(identities.map((identity) => (
            this.roomService.removeParticipant(this.roomName, identity).catch(() => {})
          )));
        },
        onProgress: (statuses, counts) => {
          this._prolificRecovery = {
            status: 'waiting-for-release',
            identity: identities.join(', '),
            submissionStatus: statuses.join(', '),
            activeCount: counts.ACTIVE ?? 0,
            reservedCount: counts.RESERVED ?? 0,
          };
          this.notifyListeners();
        },
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this._prolificRecovery = {
        status: 'error',
        identity: identities.join(', '),
        error: this.error,
      };
      this.status = 'stopped';
      this.abortController?.abort();
      this.notifyListeners();
      return false;
    }

    this._prolificRecovery = { status: 'idle' };
    for (const identity of identities) {
      this._prolificSessions.delete(identity);
      this._participantStartReports.delete(identity);
    }
    console.log('[Agent] START confirmation timeout recovered. Recruitment reopened.');
    return true;
  }

  private async execSetDisplayMode(mode: DisplayMode, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setMode' as const,
      mode,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Display mode set to: ${mode}`);
  }

  private async execSetTaskMode(taskMode: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const message: {
      type: 'taskControl';
      taskMode: string;
      taskType?: string;
      timestamp: number;
    } = {
      type: 'taskControl' as const,
      taskMode,
      timestamp: Date.now(),
    };
    if (isCursorControlExperimentTask(this.config.taskType)) {
      message.taskType = this.config.taskType;
    }
    await this.sendToRoom(CONTROL_TOPIC, message);
    console.log(`[Agent] Task mode set to: ${taskMode}`);
  }

  private async execShowYesNoAreas(
    requiredArea: 'yes' | 'no' | 'any',
    requiredRatio: number,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    const positions = this.generateNonOverlappingPositions();
    const yesNoState: YesNoAreasState = { visible: true, ...positions };

    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setYesNoAreas' as const,
      yesNoAreas: yesNoState,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Yes/No areas shown. Waiting for '${requiredArea}' area...`);

    this.areaReports.clear();

    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    while (!signal.aborted) {
      const participantCount = await this.getParticipantCount();
      this.participantCount = participantCount;

      if (participantCount > 0) {
        const reportsInArea = this.countReportsInArea(requiredArea);
        const ratio = reportsInArea / participantCount;

        if (ratio >= requiredRatio) {
          console.log(`[Agent] ${reportsInArea}/${participantCount} in '${requiredArea}' (${Math.round(ratio * 100)}%). Proceeding.`);
          return;
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        console.log(`[Agent] Yes/No timeout (${timeoutSeconds}s). Proceeding.`);
        return;
      }

      await this.sleep(1000, signal);
    }
  }

  private async execHideYesNoAreas(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const yesNoState: YesNoAreasState = {
      visible: false,
      yesPosition: { x: 0.3, y: 0.5 },
      noPosition: { x: 0.7, y: 0.5 },
    };
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setYesNoAreas' as const,
      yesNoAreas: yesNoState,
      timestamp: Date.now(),
    });
    console.log('[Agent] Yes/No areas hidden.');
  }

  private async execWait(durationSeconds: number, signal: AbortSignal): Promise<void> {
    console.log(`[Agent] Waiting ${durationSeconds} seconds...`);
    await this.sleep(durationSeconds * 1000, signal);
  }

  private async execSetCursorVisibility(hideCursor: boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setHideCursor' as const,
      hideCursor,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Cursor visibility: ${hideCursor ? 'hidden' : 'visible'}`);
  }

  private async execEnableVirtualCursor(timeoutSeconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setUseVirtualCursor' as const,
      useVirtualCursor: true,
      timestamp: Date.now(),
    });
    console.log('[Agent] Virtual cursor enabled. Waiting for pointer lock...');

    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    const hasTimeout = timeoutSeconds > 0;

    while (!signal.aborted) {
      const participantCount = await this.getParticipantCount();
      this.participantCount = participantCount;
      const requiredCount = isSharedSingleCursorExperimentTask(this.config.taskType)
        ? 2
        : participantCount;
      if (requiredCount > 0) {
        const lockedCount = this.countLockedParticipants();
        if (lockedCount >= requiredCount) {
          console.log(`[Agent] Required participants locked: ${lockedCount}/${requiredCount}. Proceeding.`);
          return;
        }
      }
      if (hasTimeout && Date.now() - startTime >= timeoutMs) {
        console.log(`[Agent] Virtual cursor timeout (${timeoutSeconds}s). Proceeding.`);
        return;
      }
      await this.sleep(1000, signal);
    }
  }

  private async execResetVirtualCursorPosition(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'resetVirtualCursorPosition' as const,
      timestamp: Date.now(),
    });
    console.log('[Agent] Virtual cursor position reset.');
  }

  private async execSetClickAreaOverlay(show: boolean, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setClickAreaOverlay' as const,
      showClickAreaOverlay: show,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Click area overlay: ${show ? 'shown' : 'hidden'}`);
  }

  private async execStartRecording(
    experimentName: string,
    trialNumber: number,
    taskType: string,
    displayMode: DisplayMode,
    participantCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    this._recordingStatus = 'recording';
    this._activeRecording = { experimentName, trialNumber };
    this._recordingUploads.set(recordingUploadKey(experimentName, trialNumber), 'recording');
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'agentStartRecording' as const,
      experimentName,
      trialNumber,
      taskType,
      displayMode,
      participantCount,
      experimentConfig: this.config,
      sourceOrigin: this.controlOrigin ?? undefined,
      timestamp: Date.now(),
    });
    console.log(
      `[Agent] Recording started: "${experimentName}" trial #${trialNumber} ` +
      `(task=${taskType}, mode=${displayMode}, n=${participantCount})`,
    );
  }

  private async execStopRecordingAndUpload(_timeoutSeconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const activeRecording = this._activeRecording;
    if (!activeRecording) {
      console.warn('[Agent] Stop recording requested without an active recording.');
      return;
    }
    this._recordingStatus = 'queued';
    this._recordingUploads.set(
      recordingUploadKey(activeRecording.experimentName, activeRecording.trialNumber),
      'queued',
    );
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'agentStopRecording' as const,
      experimentName: activeRecording.experimentName,
      trialNumber: activeRecording.trialNumber,
      sourceOrigin: this.controlOrigin ?? undefined,
      timestamp: Date.now(),
    });
    this._activeRecording = null;
    console.log(
      `[Agent] Recording queued for background upload: ${activeRecording.experimentName} ` +
      `trial #${activeRecording.trialNumber}`,
    );
  }

  private async waitForRecordingUploadsAfterCompletion(signal: AbortSignal): Promise<void> {
    const timeoutMs = 3 * 60 * 1000;
    const startedAt = Date.now();
    while (!signal.aborted) {
      const entries = [...this._recordingUploads.entries()];
      const failed = entries.filter(([, status]) => status === 'error');
      const pending = entries.filter(([, status]) => status !== 'uploaded' && status !== 'error');
      if (failed.length > 0) {
        throw new Error(`Recording upload failed after retries: ${failed.map(([key]) => key).join(', ')}`);
      }
      if (pending.length === 0) {
        this._recordingStatus = 'uploaded';
        console.log(`[Agent] All ${entries.length} recording uploads completed.`);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for recording uploads: ${pending.map(([key]) => key).join(', ')}`);
      }
      await this.sleep(500, signal);
    }
  }

  private async execEndSession(completionUrl: string | undefined, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const url = completionUrl || COMPLETION_URL;
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'complete' as const,
      url,
      timestamp: Date.now(),
    });
    scheduleEndSessionParticipantCleanup({
      roomService: this.roomService,
      roomName: this.roomName,
      participantIdentities: this._pairedParticipantIdentities,
    });
    console.log(`[Agent] Session ended. Redirecting to: ${url}`);
    await this.waitForRecordingUploadsAfterCompletion(signal);
  }

  /**
   * List current non-admin participants, randomly partition them into
   * `groupCount` groups (sizes differ by at most 1), and broadcast the
   * resulting `setGroupAssignments` control message.
   */
  private async execComputeGroups(groupCount: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const safeGroupCount = Math.max(1, Math.floor(groupCount));

    let identities: string[];
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      identities = participants
        .filter(isExperimentParticipant)
        .map((p) => p.identity);
    } catch (err) {
      console.error('[Agent] computeGroups: failed to list participants:', err);
      identities = [];
    }

    // Fisher–Yates shuffle (in-place on a copy)
    const shuffled = [...identities];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Round-robin assignment: gives groups that differ in size by at most 1
    const assignments: Record<string, number> = {};
    shuffled.forEach((identity, idx) => {
      assignments[identity] = idx % safeGroupCount;
    });

    const sizes = Array(safeGroupCount).fill(0) as number[];
    for (const g of Object.values(assignments)) sizes[g]++;
    console.log(`[Agent] computeGroups: ${shuffled.length} participants → ${safeGroupCount} groups (sizes: ${sizes.join(', ')})`);

    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setGroupAssignments' as const,
      assignments,
      groupCount: safeGroupCount,
      timestamp: Date.now(),
    });
  }

  // ─── Execute Trial (composite) ─────────────────────────────────────────

  private async execExecuteTrial(
    rule: {
      trialNumber: number;
      totalTrials: number;
      durationSeconds: number;
      taskType: ExperimentTaskType;
      experimentName: string;
      circleTargetPeriod?: number;
      circleTargetRadius?: number;
      cursorRotationDeg?: number;
      displayMode?: DisplayMode;
      sharedPhase?: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
      sharedVisualGain?: number;
      sharedDisturbance?: Record<string, unknown>;
      skipRecording?: boolean;
      recordingUploadTimeoutSeconds?: number;
    },
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const { trialNumber, totalTrials, durationSeconds, taskType, experimentName } = rule;
    const halfDurationMs = Math.floor(durationSeconds / 2) * 1000;
    const task = getTask(taskType);
    const isSharedSingleCursorTask = isSharedSingleCursorExperimentTask(taskType);
    const isCursorControlTask = isCursorControlExperimentTask(taskType);

    // Resolve the display mode for this trial: per-rule override > config
    // default > legacy 'avgOnly'.
    const trialDisplayMode: DisplayMode = rule.displayMode ?? this.config.trialDisplayMode ?? 'avgOnly';

    // If the task supplies an initial avg-cursor display position, we use the
    // *avg-cursor offset paradigm*: leave participants' cursors alone, but
    // shift the displayed avg cursor so it appears at the initial position at
    // trial start. Otherwise, fall back to the legacy "reset every cursor to
    // (0.5, 0.5)" behavior other tasks rely on.
    const initialAvgCursorPos = task.getInitialCursorPosition?.(this.config) ?? null;

    console.log(`[Agent] ── Trial ${trialNumber}/${totalTrials} (${taskType}, ${durationSeconds}s, mode=${trialDisplayMode}) ──`);

    // 0. Ensure target is hidden before trial setup
    await this.setTargetVisibility(false);

    // 1. Pre-trial message
    if (isCursorControlTask) {
      // Task 7 should move quickly: no pre-trial "start soon" screen.
    } else if (isSharedSingleCursorTask) {
      await this.sendBroadcastBottom('The next trial will start soon.', 2000);
      await this.sleep(2000, signal);
    } else {
      await this.sendBroadcastBottom(`Task will start soon (trial ${trialNumber} of ${totalTrials})`, 3000);
      await this.sleep(3000, signal);
    }
    if (signal.aborted) return;

    // Task 7 participants can accidentally release pointer lock with Esc.
    // Before the next trial begins, require only the affected participants to
    // lock the task cursor again so tracking never starts with a system cursor.
    if (isCursorControlTask) {
      await this.ensureTask7PointerLocks(signal);
      if (signal.aborted) return;
    }

    // 2. Setup: avgOnly + initial-state setup + start recording.
    // For tasks using the avg-cursor offset paradigm (reaching), we teleport
    // every participant's virtual cursor to the *avg-cursor start position*
    // (instead of stage center) before calibrating the offset. With everyone
    // already at the start position, the natural raw avg ≈ start, so the
    // computed offset is near zero — but we still apply it for defensive
    // correction against any drift. The 300ms sleep gives the admin time to
    // receive participants' post-reset cursor publishes and re-report the new
    // raw avg before we read it.
    await this.execSetDisplayMode(trialDisplayMode, signal);
    if (initialAvgCursorPos) {
      await this.setVirtualCursorPosition(initialAvgCursorPos.x, initialAvgCursorPos.y);
      await this.sleep(300, signal);
      await this.applyAvgCursorOffset(initialAvgCursorPos.x, initialAvgCursorPos.y);
    } else {
      await this.clearAvgCursorOffset();
      await this.execResetVirtualCursorPosition(signal);
    }
    // Refresh participant count once at trial start so the recording row
    // reflects the actual room state (waitForParticipants caches it but later
    // disconnects/reconnects can drift).
    this.participantCount = await this.getParticipantCount();
    if (!rule.skipRecording) {
      await this.execStartRecording(
        experimentName,
        trialNumber,
        taskType,
        trialDisplayMode,
        this.participantCount,
        signal,
      );
    } else {
      console.log(`[Agent] Recording skipped for trial #${trialNumber}.`);
    }
    if (signal.aborted) return;

    // 3. Most tasks retain the legacy centered "Start" cue. Task 6 enters
    // its home-position hold immediately after its brief pre-trial message.
    if (!isSharedSingleCursorTask) {
      await this.sendToRoom(BROADCAST_TOPIC, {
        type: 'broadcast' as const,
        text: 'Start',
        durationMs: 2000,
        severity: 'info' as const,
        position: 'center' as const,
        timestamp: Date.now(),
      });
      await this.sleep(2000, signal);
      if (signal.aborted) return;
    }

    // 4. Delegate trial body to the task module — task owns hint sends,
    //    target/guide visibility, and any custom timing during the trial.
    const ctx = this.buildTrialContext(rule, halfDurationMs, signal);
    await task.runTrialBody(ctx);
    if (signal.aborted) return;

    // 5. Post-trial. For offset-paradigm tasks the offset is recalibrated so
    //    the displayed avg snaps back to initial; for legacy tasks the
    //    participant cursors are reset to center.
    const completionDurationMs = isSharedSingleCursorTask
      ? Math.max(0, this.config.sharedWait2Seconds * 1000)
      : 2000;
    if (isCursorControlTask && trialNumber < totalTrials) {
      await this.sendBroadcastBottom(
        formatInterTrialUploadMessage(trialNumber, totalTrials),
        INTER_TRIAL_MESSAGE_DURATION_MS,
      );
    } else {
      await this.sendBroadcastBottom(`Trial ${trialNumber} of ${totalTrials} is complete.`, completionDurationMs);
    }
    if (isCursorControlTask) {
      const uploadDisplaySeconds = rule.recordingUploadTimeoutSeconds ?? Math.max(1, Math.ceil(completionDurationMs / 1000));
      if (!rule.skipRecording) {
        await this.execStopRecordingAndUpload(uploadDisplaySeconds, signal);
      }
      await this.sleep(completionDurationMs, signal);
      if (signal.aborted) return;
    } else if (isSharedSingleCursorTask) {
      await this.sleep(completionDurationMs, signal);
      if (signal.aborted) return;
    }
    if (!rule.skipRecording && !isCursorControlTask) {
      const uploadDisplaySeconds = rule.recordingUploadTimeoutSeconds ?? 120;
      await this.execStopRecordingAndUpload(uploadDisplaySeconds, signal);
    }
    await this.execSetDisplayMode('self', signal);
    if (initialAvgCursorPos) {
      // Teleport participants' virtual cursors back to the start position and
      // re-calibrate the offset so the displayed avg snaps back to the start
      // position for the next trial / the inter-trial interval.
      await this.setVirtualCursorPosition(initialAvgCursorPos.x, initialAvgCursorPos.y);
      await this.sleep(300, signal);
      await this.applyAvgCursorOffset(initialAvgCursorPos.x, initialAvgCursorPos.y);
    } else {
      await this.execResetVirtualCursorPosition(signal);
    }
    if (signal.aborted) return;
  }

  /** Build the {@link TrialContext} passed into a task's `runTrialBody`. */
  private buildTrialContext(
    rule: {
      trialNumber: number;
      totalTrials: number;
      durationSeconds: number;
      circleTargetPeriod?: number;
      circleTargetRadius?: number;
      cursorRotationDeg?: number;
      sharedPhase?: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
      sharedVisualGain?: number;
      sharedDisturbance?: Record<string, unknown>;
    },
    halfDurationMs: number,
    signal: AbortSignal,
  ): TrialContext {
    // Trial config inherits from agent config but lets rule-level circle params override
    // (so manually edited rules can vary period/radius per-trial).
    const trialConfig: ExperimentConfig = {
      ...this.config,
      circleTargetPeriod: rule.circleTargetPeriod ?? this.config.circleTargetPeriod,
      circleTargetRadius: rule.circleTargetRadius ?? this.config.circleTargetRadius,
    };

    return {
      config: trialConfig,
      trialNumber: rule.trialNumber,
      totalTrials: rule.totalTrials,
      durationSeconds: rule.durationSeconds,
      halfDurationMs,
      cursorRotationDeg: rule.cursorRotationDeg,
      sharedPhase: rule.sharedPhase,
      sharedVisualGain: rule.sharedVisualGain,
      sharedDisturbance: rule.sharedDisturbance,
      signal,
      broadcastTop: (text, durationMs) => this.sendBroadcastTop(text, durationMs),
      broadcastBottom: (text, durationMs) => this.sendBroadcastBottom(text, durationMs),
      setTargetVisibility: (visible) => this.setTargetVisibility(visible),
      setGuideRunning: (running, radius) => this.setGuideRunning(running, radius),
      publishCircleTarget: (period, radius, durationMs) =>
        this.publishCircleTargetForDuration(period, radius, durationMs, signal),
      setCursorRotation: (degrees) => this.setCursorRotation(degrees),
      setVirtualCursorPosition: (x, y) => this.setVirtualCursorPosition(x, y),
      setUseVirtualCursor: (enabled) => this.setUseVirtualCursor(enabled),
      setClickAreaOverlay: (show) => this.setClickAreaOverlay(show),
      unlockPointerLock: () => this.unlockPointerLock(),
      applyAvgCursorOffset: (x, y) => this.applyAvgCursorOffset(x, y),
      publishStaticTarget: (x, y, shape, color) => this.publishStaticTarget(x, y, shape, color),
      waitForAvgCursorNear: (x, y, threshold, timeoutMs) =>
        this.waitForAvgCursorNear(x, y, threshold, timeoutMs, signal),
      waitForAvgCursorFar: (fromX, fromY, threshold, timeoutMs) =>
        this.waitForAvgCursorFar(fromX, fromY, threshold, timeoutMs, signal),
      startSketchHitDetector: (params) => this.startSketchHitDetector(params),
      stopSketchHitDetector: () => this.stopSketchHitDetector(),
      waitForSketchEvent: (name, timeoutMs) =>
        this.waitForSketchEvent(name, timeoutMs, signal),
      startSketchTrajectory: (params) => this.startSketchTrajectory(params),
      stopSketchTrajectory: () => this.stopSketchTrajectory(),
      publishSketchTrajectory: (params, durationMs) =>
        this.publishSketchTrajectory(params, durationMs, signal),
      publishInitialTargetWithTrajectory: (params) =>
        this.publishInitialTargetWithTrajectory(params),
      setRecordingMetadata: (metadata) => this.setRecordingMetadata(metadata),
      waitForSharedTrackingCompletions: (trialKey, requiredCount, timeoutMs) =>
        this.waitForSharedTrackingCompletions(trialKey, requiredCount, timeoutMs, signal),
      setSharedCursorControl: (params) => this.setSharedCursorControl(params),
      showSharedCursorQuestionnaire: (trialNumber, kind) => this.showSharedCursorQuestionnaire(trialNumber, kind),
      hideSharedCursorQuestionnaire: () => this.hideSharedCursorQuestionnaire(),
      waitForSharedCursorResponses: (trialNumber, requiredCount, timeoutMs) =>
        this.waitForSharedCursorResponses(trialNumber, requiredCount, timeoutMs, signal),
      sleep: (ms) => this.sleep(ms, signal),
    };
  }

  /** Send `setTargetVisibility` control message. */
  private async setTargetVisibility(visible: boolean): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setTargetVisibility' as const,
      visible,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Target visibility: ${visible}`);
  }

  /**
   * Send `setGuideTrackingRunning` control message. When `radius` is
   * provided, clients also update their local `circleTargetRadius` state
   * so the guide is drawn with the experiment-config radius (set via
   * AgentAdmin). Without this propagation, clients would render the
   * guide at their stale default radius (0.3) instead of the configured
   * value.
   */
  private async setGuideRunning(running: boolean, radius?: number): Promise<void> {
    const message: Record<string, unknown> = {
      type: 'setGuideTrackingRunning' as const,
      guideTrackingRunning: running,
      timestamp: Date.now(),
    };
    if (typeof radius === 'number' && Number.isFinite(radius)) {
      message.radius = radius;
    }
    await this.sendToRoom(CONTROL_TOPIC, message);
    console.log(
      `[Agent] Guide tracking running: ${running}` +
      (typeof radius === 'number' ? `, radius=${radius}` : ''),
    );
  }

  /** Send `setCursorRotation` control message (visuomotor rotation in degrees). */
  private async setCursorRotation(degrees: number): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setCursorRotation' as const,
      degrees,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Cursor rotation: ${degrees}°`);
  }

  /** Send `setVirtualCursorPosition` control message. */
  private async setVirtualCursorPosition(x: number, y: number): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setVirtualCursorPosition' as const,
      x,
      y,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Virtual cursor position set to (${x.toFixed(2)}, ${y.toFixed(2)})`);
  }

  private async setUseVirtualCursor(enabled: boolean): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setUseVirtualCursor' as const,
      useVirtualCursor: enabled,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Virtual cursor: ${enabled ? 'ON' : 'OFF'}`);
  }

  private async setClickAreaOverlay(show: boolean): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setClickAreaOverlay' as const,
      showClickAreaOverlay: show,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Click area overlay: ${show ? 'shown' : 'hidden'}`);
  }

  private async unlockPointerLock(): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'unlockPointerLock' as const,
      timestamp: Date.now(),
    });
    console.log('[Agent] Pointer lock unlock requested.');
  }

  /**
   * Publish a single static target position on TARGET_TOPIC. Optional `color`
   * is forwarded to clients which render the target fill with this CSS color
   * (e.g. 'yellow', '#ef4444'). When omitted, clients use their task-mode
   * default color.
   */
  private async publishStaticTarget(
    x: number,
    y: number,
    shape: 'circle' | 'square' | 'triangle',
    color?: string,
  ): Promise<void> {
    const message: Record<string, unknown> = {
      type: 'target' as const,
      x,
      y,
      shape,
      timestamp: Date.now(),
    };
    if (color !== undefined) message.color = color;
    await this.sendToRoom(TARGET_TOPIC, message);
    console.log(
      `[Agent] Static target published at (${x.toFixed(2)}, ${y.toFixed(2)}), shape=${shape}` +
      (color ? `, color=${color}` : ''),
    );
  }

  /** Send `setAvgCursorOffset` to all clients (no local-state mutation). */
  private async broadcastAvgCursorOffset(x: number, y: number): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setAvgCursorOffset' as const,
      x,
      y,
      timestamp: Date.now(),
    });
  }

  /**
   * Calibrate the avg-cursor display so it appears at `(initialX, initialY)`
   * right now. Reads the latest raw avg report from the admin, computes
   * `offset = rawAvg - initial`, stores it locally for use by
   * `waitForAvgCursorNear`, and broadcasts to every client so they apply the
   * same offset to the displayed avg cursor. Used by the reaching task at
   * trial start.
   */
  private async applyAvgCursorOffset(initialX: number, initialY: number): Promise<void> {
    // Wait briefly for a fresh raw avg report — admin posts at 10Hz once
    // taskMode becomes 'reaching', so it usually arrives within a few hundred ms.
    const STALE_AFTER_MS = 1000;
    const WAIT_DEADLINE_MS = Date.now() + 2000;
    while (Date.now() < WAIT_DEADLINE_MS) {
      const r = this._avgCursorReport;
      if (r && Date.now() - r.timestamp <= STALE_AFTER_MS) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const report = this._avgCursorReport;
    if (!report || Date.now() - report.timestamp > STALE_AFTER_MS) {
      console.warn('[Agent] applyAvgCursorOffset: no fresh raw avg cursor report; using zero offset');
      this._avgCursorOffset = { x: 0, y: 0 };
      await this.broadcastAvgCursorOffset(0, 0);
      return;
    }
    const offset = { x: report.x - initialX, y: report.y - initialY };
    this._avgCursorOffset = offset;
    console.log(
      `[Agent] applyAvgCursorOffset: raw=(${report.x.toFixed(3)},${report.y.toFixed(3)}) ` +
      `→ initial=(${initialX.toFixed(2)},${initialY.toFixed(2)}) ` +
      `offset=(${offset.x.toFixed(3)},${offset.y.toFixed(3)})`,
    );
    await this.broadcastAvgCursorOffset(offset.x, offset.y);
  }

  /** Clear the avg-cursor offset (reset to zero shift). */
  private async clearAvgCursorOffset(): Promise<void> {
    this._avgCursorOffset = { x: 0, y: 0 };
    await this.broadcastAvgCursorOffset(0, 0);
  }

  /**
   * Poll the latest avg cursor report (from admin client) and resolve when the
   * reported position — adjusted by the current avg-cursor offset — is within
   * `threshold` (Euclidean stage units) of the specified point, or until
   * `timeoutMs` elapses.
   *
   * The admin always posts the *raw* avg; this method applies
   * `_avgCursorOffset` locally so the comparison is done in the same
   * coordinate frame the participants see.
   */
  private async waitForAvgCursorNear(
    targetX: number,
    targetY: number,
    threshold: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ reached: boolean }> {
    const POLL_INTERVAL = 50;
    const STALE_AFTER_MS = 1000;
    const startTime = Date.now();
    while (!signal.aborted) {
      const report = this._avgCursorReport;
      const now = Date.now();
      if (report && now - report.timestamp <= STALE_AFTER_MS) {
        const displayedX = report.x - this._avgCursorOffset.x;
        const displayedY = report.y - this._avgCursorOffset.y;
        const dx = displayedX - targetX;
        const dy = displayedY - targetY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= threshold) {
          console.log(`[Agent] Avg cursor reached target (displayed=(${displayedX.toFixed(3)},${displayedY.toFixed(3)}), dist=${dist.toFixed(3)}).`);
          return { reached: true };
        }
      }
      if (now - startTime >= timeoutMs) {
        console.log(`[Agent] waitForAvgCursorNear: timeout (${timeoutMs}ms).`);
        return { reached: false };
      }
      await this.sleep(POLL_INTERVAL, signal);
    }
    return { reached: false };
  }

  /**
   * Mirror of {@link waitForAvgCursorNear}: poll the latest displayed avg
   * cursor (rawAvg − offset) and resolve as soon as it has moved *farther* than
   * `threshold` from `(fromX, fromY)`, or when `timeoutMs` elapses.
   */
  private async waitForAvgCursorFar(
    fromX: number,
    fromY: number,
    threshold: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ moved: boolean }> {
    const POLL_INTERVAL = 50;
    const STALE_AFTER_MS = 1000;
    const startTime = Date.now();
    while (!signal.aborted) {
      const report = this._avgCursorReport;
      const now = Date.now();
      if (report && now - report.timestamp <= STALE_AFTER_MS) {
        const displayedX = report.x - this._avgCursorOffset.x;
        const displayedY = report.y - this._avgCursorOffset.y;
        const dx = displayedX - fromX;
        const dy = displayedY - fromY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > threshold) {
          console.log(
            `[Agent] waitForAvgCursorFar: motion detected (displayed=(${displayedX.toFixed(3)},${displayedY.toFixed(3)}), ` +
            `dist=${dist.toFixed(3)} > threshold=${threshold.toFixed(3)}).`,
          );
          return { moved: true };
        }
      }
      if (now - startTime >= timeoutMs) {
        return { moved: false };
      }
      await this.sleep(POLL_INTERVAL, signal);
    }
    return { moved: false };
  }

  /**
   * Send `startSketchHitDetector` control message — admin client begins
   * polling its active sketch's `hit.detect(ctx)` predicate at the sketch's
   * configured interval. The first true firing POSTs to /agent/sketch-event
   * which this agent reads via `waitForSketchEvent`.
   *
   * `params` are forwarded verbatim and exposed to the sketch's
   * `detect(ctx)` as `ctx.params`. Pass whatever task-specific values the
   * sketch needs (e.g. `{ threshold }` for Euclidean reach, polygon
   * vertices for arbitrary shapes, etc.).
   */
  private async startSketchHitDetector(params?: Record<string, unknown>): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'startSketchHitDetector' as const,
      params: params ?? {},
      timestamp: Date.now(),
    });
    console.log(`[Agent] Sketch hit detector: start (params=${JSON.stringify(params ?? {})})`);
  }

  /** Stop sketch hit polling on admin client(s). */
  private async stopSketchHitDetector(): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'stopSketchHitDetector' as const,
      timestamp: Date.now(),
    });
    console.log('[Agent] Sketch hit detector: stop');
  }

  /**
   * Poll the sketch-event inbox until an entry with the given `name`
   * arrives, or until `timeoutMs` elapses. Returns whether the event fired
   * and the optional data payload from the admin's POST.
   *
   * On entry, any stale entry for this name is cleared so we never pick up
   * a hit from a previous trial. On match, the entry is consumed so a
   * subsequent wait starts fresh.
   */
  private async waitForSketchEvent(
    name: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ fired: boolean; data?: unknown }> {
    this._sketchEventInbox.delete(name);
    const POLL_INTERVAL = 50;
    const startTime = Date.now();
    while (!signal.aborted) {
      const entry = this._sketchEventInbox.get(name);
      if (entry) {
        this._sketchEventInbox.delete(name);
        console.log(`[Agent] Sketch event '${name}' fired after ${Date.now() - startTime}ms.`);
        return { fired: true, data: entry.data };
      }
      if (Date.now() - startTime >= timeoutMs) {
        console.log(`[Agent] waitForSketchEvent('${name}'): timeout (${timeoutMs}ms).`);
        return { fired: false };
      }
      await this.sleep(POLL_INTERVAL, signal);
    }
    return { fired: false };
  }

  /**
   * Send `startSketchTrajectory` control message with task-specific
   * params. Admin client looks up its active sketch's `trajectory.compute`
   * function and starts a publish loop at the sketch's configured interval.
   * Each frame's returned `{x, y, shape?, color?}` is published on
   * TARGET_TOPIC for all participants to render.
   */
  private async startSketchTrajectory(params: Record<string, unknown>): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'startSketchTrajectory' as const,
      params,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Sketch trajectory: start (params=${JSON.stringify(params)})`);
  }

  /** Stop the admin client's trajectory publish loop. */
  private async stopSketchTrajectory(): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'stopSketchTrajectory' as const,
      timestamp: Date.now(),
    });
    console.log('[Agent] Sketch trajectory: stop');
  }

  /**
   * Run an admin-driven trajectory for `durationMs`: start, sleep,
   * stop. The actual position computation happens on the admin client
   * via the active sketch's `trajectory.compute()`; this method only
   * brackets the window.
   */
  private async publishSketchTrajectory(
    params: Record<string, unknown>,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.startSketchTrajectory(params);
    try {
      await this.sleep(durationMs, signal);
    } finally {
      // Always stop even if aborted, so admin doesn't keep publishing.
      await this.stopSketchTrajectory().catch(() => {});
    }
  }

  private async publishInitialTargetWithTrajectory(params: Record<string, unknown>): Promise<void> {
    await this.sendToRoom(TARGET_TOPIC, {
      type: 'target' as const,
      x: 0.5,
      y: 0.5,
      shape: typeof params.shape === 'string' ? params.shape : 'circle',
      trajectoryParams: params,
      trajectoryElapsedMs: 0,
      timestamp: Date.now(),
    });
    console.log('[Agent] Initial trajectory target published.');
  }

  private async setRecordingMetadata(metadata: Record<string, unknown>): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setRecordingMetadata' as const,
      trialMetadata: metadata,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Recording metadata updated: ${JSON.stringify(metadata)}`);
  }

  private async waitForSharedTrackingCompletions(
    trialKey: string,
    requiredCount: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ completed: number }> {
    this._sharedTrackingCompletions.delete(trialKey);
    const startTime = Date.now();
    const POLL_INTERVAL = 100;
    while (!signal.aborted) {
      this.participantCount = await this.getParticipantCount();
      const completed = this._sharedTrackingCompletions.get(trialKey)?.size ?? 0;
      if (completed >= requiredCount) {
        console.log(`[Agent] Shared tracking complete: ${completed}/${requiredCount}`);
        return { completed };
      }
      if (this.participantCount < requiredCount) {
        await this.handleSharedParticipantDisconnect(
          'tracking',
          this.participantCount,
          requiredCount,
          signal,
        );
      }
      if (Date.now() - startTime >= timeoutMs) {
        console.log(`[Agent] Shared tracking completion timeout: ${completed}/${requiredCount}`);
        if (completed < requiredCount) {
          const completedIdentities = this._sharedTrackingCompletions.get(trialKey) ?? new Map();
          const inactiveIdentity = this._pairedParticipantIdentities.find(
            (identity) => !completedIdentities.has(identity),
          );
          await this.handleSharedParticipantDisconnect(
            'inactivity timeout',
            completed,
            requiredCount,
            signal,
            inactiveIdentity,
            'participant inactivity timeout',
          );
        }
        return { completed };
      }
      await this.sleep(POLL_INTERVAL, signal);
    }
    return { completed: this._sharedTrackingCompletions.get(trialKey)?.size ?? 0 };
  }

  private async waitForInstructionNext(
    instructionId: string,
    signal: AbortSignal,
  ): Promise<{ completed: number; required: number }> {
    const POLL_INTERVAL = 100;
    const required = isSharedSingleCursorExperimentTask(this.config.taskType)
      ? 2
      : Math.max(1, this.config.minParticipants);
    while (!signal.aborted) {
      this.participantCount = await this.getParticipantCount();
      const completed = this._instructionNextReports.get(instructionId)?.size ?? 0;
      if (completed >= required) {
        console.log(`[Agent] Instruction Next complete: ${completed}/${required}`);
        return { completed, required };
      }
      if (isSharedSingleCursorExperimentTask(this.config.taskType) && this.participantCount < required) {
        await this.handleSharedParticipantDisconnect(
          'instruction',
          this.participantCount,
          required,
          signal,
        );
      }
      await this.sleep(POLL_INTERVAL, signal);
    }
    return { completed: this._instructionNextReports.get(instructionId)?.size ?? 0, required };
  }

  private async setSharedCursorControl(params: {
    enabled: boolean;
    phase?: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
    matrix?: number[];
    visualGain?: number;
    disturbance?: Record<string, unknown>;
  }): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'setSharedCursorControl' as const,
      ...params,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Shared cursor control: ${params.enabled ? params.phase ?? 'shared' : 'off'}`);
  }

  private async showSharedCursorQuestionnaire(
    trialNumber: number,
    kind: 'legacy' | 'contribution' = 'legacy',
  ): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'showSharedCursorQuestionnaire' as const,
      trialNumber,
      kind,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Shared cursor questionnaire: show trial ${trialNumber} (${kind})`);
  }

  private async hideSharedCursorQuestionnaire(): Promise<void> {
    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'hideSharedCursorQuestionnaire' as const,
      timestamp: Date.now(),
    });
    console.log('[Agent] Shared cursor questionnaire: hide');
  }

  private async waitForSharedCursorResponses(
    trialNumber: number,
    requiredCount: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ completed: number }> {
    const startTime = Date.now();
    const POLL_INTERVAL = 100;
    while (!signal.aborted) {
      this.participantCount = await this.getParticipantCount();
      const completed = this._sharedCursorResponses.get(trialNumber)?.size ?? 0;
      if (completed >= requiredCount) {
        console.log(`[Agent] Shared cursor questionnaire complete: ${completed}/${requiredCount}`);
        return { completed };
      }
      if (this.participantCount < requiredCount) {
        await this.handleSharedParticipantDisconnect(
          'questionnaire',
          this.participantCount,
          requiredCount,
          signal,
        );
      }
      if (Date.now() - startTime >= timeoutMs) {
        console.log(`[Agent] Shared cursor questionnaire timeout: ${completed}/${requiredCount}`);
        return { completed };
      }
      await this.sleep(POLL_INTERVAL, signal);
    }
    return { completed: this._sharedCursorResponses.get(trialNumber)?.size ?? 0 };
  }

  private async handleSharedParticipantDisconnect(
    stage: 'instruction' | 'tracking' | 'questionnaire' | 'pointer lock recovery' | 'inactivity timeout' | 'withdrawal',
    activeCount: number,
    requiredCount: number,
    signal: AbortSignal,
    responsibleIdentity?: string,
    reason: string = stage,
  ): Promise<never> {
    const message = stage === 'inactivity timeout'
      ? `Shared cursor task interrupted: ${activeCount}/${requiredCount} participants completed the current step before timeout.`
      : `Shared cursor task interrupted during ${stage}: ${activeCount}/${requiredCount} participants remain connected.`;
    if (!this._sharedDisconnectHandled && !signal.aborted) {
      this._sharedDisconnectHandled = true;
      console.warn(`[Agent] ${message}`);
      const activeIdentities = await this.getExperimentParticipantIdentities().catch(() => [] as string[]);
      const knownIdentities = [...new Set([
        ...this._pairedParticipantIdentities,
        ...activeIdentities,
        ...(responsibleIdentity ? [responsibleIdentity] : []),
      ])];
      const inferredResponsibleIdentity = responsibleIdentity
        ?? knownIdentities.find((identity) => !activeIdentities.includes(identity));
      const sessions = knownIdentities.map((identity) => ({
        identity,
        session: this._prolificSessions.get(identity),
      }));

      // Ending the live experiment is independent from Prolific automation.
      // Notify the participant who is still connected and disable the active
      // task before any external API recovery work, which may be unavailable
      // in local development or take several seconds in production.
      if (inferredResponsibleIdentity) {
        this._terminationOutcomes = buildParticipantTerminationOutcomes({
          participantIdentities: knownIdentities,
          responsibleIdentity: inferredResponsibleIdentity,
          reason,
          elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        });
        for (const outcome of this._terminationOutcomes) {
          if (!activeIdentities.includes(outcome.identity)) continue;
          await this.sendToParticipants(CONTROL_TOPIC, {
            type: 'participantTermination',
            disposition: outcome.disposition,
            reason: outcome.reason,
            elapsedSeconds: outcome.elapsedSeconds,
            timestamp: Date.now(),
          }, [outcome.identity]).catch(() => {});
        }
        this.notifyListeners();
      }
      await this.setTargetVisibility(false).catch(() => {});
      await this.setSharedCursorControl({ enabled: false }).catch(() => {});
      await this.unlockPointerLock().catch(() => {});
      await this.setUseVirtualCursor(false).catch(() => {});
      await this.hideSharedCursorQuestionnaire().catch(() => {});
      if (this._recordingStatus === 'recording' || this._recordingStatus === 'uploading') {
        await this.sendBroadcastTop('Data is now uploading...', 8000).catch(() => {});
        await this.execStopRecordingAndUpload(5, signal).catch((err) => {
          console.warn('[Agent] Partial recording upload after disconnect did not complete:', err);
        });
      }

      const studyIds = [...new Set(sessions.map(({ session }) => session?.studyId).filter(Boolean))];
      const missingSession = sessions.find(({ session }) => !session);

      // Once both participants have confirmed START, this Prolific study is a
      // single-use paired session. Keep it paused permanently: do not request
      // returns automatically and never call START to reopen recruitment.
      // Participant compensation remains a manual researcher decision.
      if (
        this._pairedParticipantIdentities.length === 2
        && this.prolificGateway
        && !missingSession
        && studyIds.length === 1
        && knownIdentities.length === 2
      ) {
        await this.pauseProlificStudyAfterStart(knownIdentities);
        await this.sleep(1000, signal).catch(() => {});
        await Promise.all(knownIdentities.map((identity) => (
          this.roomService.removeParticipant(this.roomName, identity).catch(() => {})
        )));
        this._prolificRecovery = {
          status: 'paused-after-start',
          identity: knownIdentities.join(', '),
        };
        this.status = 'stopped';
        this._restartRequested = false;
        this.abortController?.abort();
        this.notifyListeners();
        console.log('[Agent] Paired session stopped. Prolific recruitment remains paused after START.');
        throw new PairedSessionStoppedError(message);
      }

      if (!this.prolificGateway || missingSession || studyIds.length !== 1 || knownIdentities.length !== 2) {
        const missing = !this.prolificGateway
          ? 'PROLIFIC_API_TOKEN is not configured'
          : missingSession
            ? `STUDY_ID or SESSION_ID was not registered for ${missingSession.identity}`
            : knownIdentities.length !== 2
              ? `expected 2 paired participants but found ${knownIdentities.length}`
              : 'participants were registered under different Prolific studies';
        this.error = `Paired-session recovery stopped safely: ${missing}.`;
        this._prolificRecovery = { status: 'error', identity: knownIdentities.join(', '), error: this.error };
        this.status = 'stopped';
        this.abortController?.abort();
        this.notifyListeners();
        throw new Error(this.error);
      }

      const studyId = studyIds[0] as string;
      const submissionIds = sessions.map(({ session }) => session!.submissionId);
      this._prolificRecovery = { status: 'pausing', identity: knownIdentities.join(', ') };
      this.notifyListeners();
      try {
        await recoverProlificStudySubmissions({
          gateway: this.prolificGateway,
          studyId,
          submissionIds,
          returnReason: stage === 'inactivity timeout'
            ? 'The paired experiment ended because one participant stopped responding for two minutes.'
            : 'The paired experiment ended because one participant left the experiment.',
          signal,
          onPaused: async () => {},
          onReturnRequested: async () => {
            await this.sleep(1000, signal);
            await Promise.all(knownIdentities.map((identity) => (
              this.roomService.removeParticipant(this.roomName, identity).catch(() => {})
            )));
          },
          onProgress: (statuses, counts) => {
            this._prolificRecovery = {
              status: 'waiting-for-release',
              identity: knownIdentities.join(', '),
              submissionStatus: statuses.join(', '),
              activeCount: counts.ACTIVE ?? 0,
              reservedCount: counts.RESERVED ?? 0,
            };
            this.notifyListeners();
          },
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this._prolificRecovery = {
          status: 'error',
          identity: knownIdentities.join(', '),
          error: this.error,
        };
        this.status = 'stopped';
        this.abortController?.abort();
        this.notifyListeners();
        throw err;
      }

      for (const identity of knownIdentities) {
        this._prolificSessions.delete(identity);
        this._participantStartReports.delete(identity);
      }
      this._prolificRecovery = { status: 'idle' };
      this._restartRequested = true;
      this.abortController?.abort();
      this.notifyListeners();
      console.log('[Agent] Paired-session recovery complete. Recruitment reopened for two new participants.');
      throw new PairedSessionRecoveredError(message);
    }
    if (this.status === 'stopped') {
      throw new PairedSessionStoppedError(message);
    }
    throw new Error(message);
  }

  private async pauseProlificStudyAfterStart(identities: string[]): Promise<void> {
    const sessions = identities.map((identity) => this._prolificSessions.get(identity));
    const registeredSessions = sessions.filter((session): session is ProlificSession => Boolean(session));

    // Local development does not include STUDY_ID / SESSION_ID parameters.
    if (registeredSessions.length === 0) return;
    if (!this.prolificGateway || registeredSessions.length !== identities.length) {
      throw new Error('Cannot start the paired experiment until both Prolific sessions are registered.');
    }

    const studyIds = [...new Set(registeredSessions.map((session) => session.studyId))];
    if (studyIds.length !== 1) {
      throw new Error('Cannot start participants registered under different Prolific studies.');
    }

    const studyId = studyIds[0];
    if (this._pausedProlificStudyId !== studyId) {
      await this.prolificGateway.pauseStudy(studyId);
      this._pausedProlificStudyId = studyId;
      console.log(`[Agent] Prolific study ${studyId} paused after both participants confirmed START.`);
    }
    this._prolificRecovery = {
      status: 'paused-after-start',
      identity: identities.join(', '),
    };
    this.notifyListeners();
  }

  /**
   * Publish circle target positions on TARGET_TOPIC for a given duration.
   * Agent computes positions directly — no dependency on admin client animation.
   *
   * Note: this is the *legacy* path. New tasks should prefer
   * {@link publishSketchTrajectory}, which delegates the motion equation
   * to the active sketch on the admin client.
   */
  private async publishCircleTargetForDuration(
    period: number,
    radius: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const PUBLISH_INTERVAL = 50; // 20 Hz
    const startTime = Date.now();

    while (!signal.aborted) {
      const now = Date.now();
      const elapsed = now - startTime;
      if (elapsed >= durationMs) return;

      const angle = (elapsed / period) * 2 * Math.PI;
      const x = 0.5 + radius * Math.cos(angle);
      const y = 0.5 + radius * Math.sin(angle);

      await this.sendToRoom(TARGET_TOPIC, {
        type: 'target' as const,
        x,
        y,
        shape: 'square' as const,
        timestamp: now,
      }).catch(() => {});

      await this.sleep(PUBLISH_INTERVAL, signal);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async sendBroadcastTop(text: string, durationMs: number): Promise<void> {
    const message = {
      type: 'broadcast' as const,
      text,
      durationMs,
      severity: 'info' as const,
      position: 'top' as const,
      timestamp: Date.now(),
    };
    await this.sendToRoom(BROADCAST_TOPIC, message).catch(() => {});
    console.log(`[Agent] Broadcast (top): "${text}"`);
  }

  private async sendBroadcastBottom(text: string, durationMs: number): Promise<void> {
    const message = {
      type: 'broadcast' as const,
      text,
      durationMs,
      severity: 'info' as const,
      position: 'bottom' as const,
      timestamp: Date.now(),
    };
    await this.sendToRoom(BROADCAST_TOPIC, message).catch(() => {});
    console.log(`[Agent] Broadcast (bottom): "${text}"`);
  }

  private async getParticipantCount(): Promise<number> {
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      return participants.filter(isExperimentParticipant).length;
    } catch (err) {
      console.error('[Agent] Failed to list participants:', err);
      return this.participantCount;
    }
  }

  private async getExperimentParticipantIdentities(): Promise<string[]> {
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      return participants.filter(isExperimentParticipant).map((participant) => participant.identity);
    } catch (err) {
      console.error('[Agent] Failed to list participant identities:', err);
      return [];
    }
  }

  private hasCoordinatedMovement(identities: string[]): boolean {
    if (identities.length < 2) return false;
    const now = Date.now();
    return identities.every((identity) => {
      const history = (this._cursorReadiness.get(identity) ?? []).filter((entry) => now - entry.timestamp <= 1000);
      if (history.length < 2) return false;
      const first = history[0];
      const last = history[history.length - 1];
      return Math.hypot(last.x - first.x, last.y - first.y) >= 0.015;
    });
  }

  private async ensureTask7PointerLocks(signal: AbortSignal): Promise<void> {
    const initialIdentities = (await this.getExperimentParticipantIdentities()).slice(0, 2);
    if (initialIdentities.length < 2) return;

    const recoveryIdentities = initialIdentities.filter((identity) => {
      const report = this.virtualCursorReports.get(identity);
      return report !== undefined && !report.isPointerLocked;
    });
    if (recoveryIdentities.length === 0) return;

    await this.sendToRoom(CONTROL_TOPIC, {
      type: 'task7PointerLockRecovery' as const,
      identities: recoveryIdentities,
      timestamp: Date.now(),
    });
    console.log(`[Agent] Task 7 pointer-lock recovery required: ${recoveryIdentities.join(', ')}`);

    while (!signal.aborted) {
      const activeIdentities = (await this.getExperimentParticipantIdentities()).slice(0, 2);
      this.participantCount = activeIdentities.length;
      if (activeIdentities.length < 2) {
        await this.handleSharedParticipantDisconnect('pointer lock recovery', activeIdentities.length, 2, signal);
      }

      const activeRecoveryIdentities = recoveryIdentities.filter((identity) => activeIdentities.includes(identity));
      const allLocked = activeRecoveryIdentities.every((identity) =>
        this.virtualCursorReports.get(identity)?.isPointerLocked === true,
      );
      if (allLocked) {
        console.log('[Agent] Task 7 pointer-lock recovery complete.');
        return;
      }
      await this.sleep(100, signal);
    }
  }

  private async refreshRoomConnectionCounts(): Promise<void> {
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      this.participantCount = participants.filter(isExperimentParticipant).length;
      this.adminConnectionCount = participants.filter(isAdminConnection).length;
    } catch (err) {
      console.error('[Agent] Failed to list room connections:', err);
    }
  }

  private async sendToRoom(topic: string, message: Record<string, unknown>): Promise<void> {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    try {
      await this.roomService.sendData(this.roomName, payload, DataPacket_Kind.RELIABLE, {
        topic,
      });
    } catch (err) {
      console.error(`[Agent] Failed to send data (topic: ${topic}):`, err);
      throw err;
    }
  }

  private async sendToParticipants(
    topic: string,
    message: Record<string, unknown>,
    destinationIdentities: string[],
  ): Promise<void> {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    await this.roomService.sendData(this.roomName, payload, DataPacket_Kind.RELIABLE, {
      topic,
      destinationIdentities,
    });
  }

  private async removeSyntheticParticipantsForSharedTask(): Promise<void> {
    try {
      const participants = await this.roomService.listParticipants(this.roomName);
      const synthetic = participants.filter((participant) => isSyntheticParticipantIdentity(participant.identity));
      await Promise.all(synthetic.map((participant) =>
        this.roomService.removeParticipant(this.roomName, participant.identity).catch((err) => {
          console.warn(`[Agent] Failed to remove synthetic participant ${participant.identity}:`, err);
        }),
      ));
      if (synthetic.length > 0) {
        console.log(`[Agent] Removed ${synthetic.length} synthetic participants before Task 6.`);
      }
    } catch (err) {
      console.warn('[Agent] Failed to inspect synthetic participants before Task 6:', err);
    }
  }

  private countReportsInArea(requiredArea: 'yes' | 'no' | 'any'): number {
    let count = 0;
    const now = Date.now();
    for (const report of this.areaReports.values()) {
      if (now - report.timestamp > 5000) continue;
      if (requiredArea === 'any') {
        if (report.area === 'yes' || report.area === 'no') count++;
      } else if (report.area === requiredArea) {
        count++;
      }
    }
    return count;
  }

  private countLockedParticipants(): number {
    let count = 0;
    for (const report of this.virtualCursorReports.values()) {
      if (report.isPointerLocked) count++;
    }
    return count;
  }

  private generateNonOverlappingPositions(): {
    yesPosition: { x: number; y: number };
    noPosition: { x: number; y: number };
  } {
    const MARGIN = 0.15;
    const AREA_RADIUS = 0.08;
    const MIN_DISTANCE = AREA_RADIUS * 3;
    const MIN_DISTANCE_FROM_PREVIOUS_YES = AREA_RADIUS * 4;

    const randomPos = () => ({
      x: MARGIN + Math.random() * (1 - 2 * MARGIN),
      y: MARGIN + Math.random() * (1 - 2 * MARGIN),
    });

    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

    let yesPos = randomPos();
    const prev = this.previousYesPosition;
    if (prev) {
      let yesAttempts = 0;
      while (distance(yesPos, prev) < MIN_DISTANCE_FROM_PREVIOUS_YES && yesAttempts < 100) {
        yesPos = randomPos();
        yesAttempts++;
      }
      if (distance(yesPos, prev) < MIN_DISTANCE_FROM_PREVIOUS_YES) {
        // Fallback when random retries fail: pick the in-bounds corner farthest from prev
        const corners = [
          { x: MARGIN, y: MARGIN },
          { x: 1 - MARGIN, y: MARGIN },
          { x: MARGIN, y: 1 - MARGIN },
          { x: 1 - MARGIN, y: 1 - MARGIN },
        ];
        yesPos = corners.reduce(
          (best, c) => (distance(c, prev) > distance(best, prev) ? c : best),
          corners[0],
        );
      }
    }

    let noPos = randomPos();
    let noAttempts = 0;
    while (distance(yesPos, noPos) < MIN_DISTANCE && noAttempts < 100) {
      noPos = randomPos();
      noAttempts++;
    }

    if (distance(yesPos, noPos) < MIN_DISTANCE) {
      yesPos = { x: 0.25, y: 0.5 };
      noPos = { x: 0.75, y: 0.5 };
    }

    this.previousYesPosition = yesPos;

    return { yesPosition: yesPos, noPosition: noPos };
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
