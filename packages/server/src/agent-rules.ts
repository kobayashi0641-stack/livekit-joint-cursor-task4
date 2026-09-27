/**
 * Agent Rule Types for automated experiment control.
 *
 * Each rule represents a step the agent executes sequentially.
 *
 * The full rule sequence is built in `experiments/index.ts`
 * (`generateRulesFromConfig`) by combining `experiments/common-flow.ts`
 * fragments with the per-task module under `experiments/<task-id>/`.
 */

export type DisplayMode =
  | 'all-without-avg'
  | 'all-with-avg-lines'
  | 'all-with-avg-no-lines'
  | 'avgOnly'
  | 'self'
  | 'self-with-avg';
export type TaskMode = 'target-tracking' | 'manual-instruction' | 'circle-target-tracking' | 'guide-tracking' | 'random-target-tracking' | 'reaching' | 'shared-single-cursor';

// ---------------------------------------------------------------------------
// Experiment configuration
// ---------------------------------------------------------------------------

export type ExperimentTaskType =
  | 'circle-target-tracking'
  | 'guide-tracking'
  | 'non-guide-tracking'
  | 'group-circle-target-tracking'
  | 'reaching'
  | 'shared-single-cursor-control'
  | 'cursor-control-20260706'
  | 'task8'
  | 'task9';

export function isSharedSingleCursorExperimentTask(taskType: ExperimentTaskType): boolean {
  return taskType === 'shared-single-cursor-control' || isCursorControlExperimentTask(taskType);
}

export function isCursorControlExperimentTask(taskType: ExperimentTaskType): boolean {
  return taskType === 'cursor-control-20260706' || taskType === 'task8' || taskType === 'task9';
}

export type ExperimentConfig = {
  taskType: ExperimentTaskType;
  trialCount: number;
  trialDurationSeconds: number;
  waitTimeMinutes: number;
  minParticipants: number;
  instructionDurationMs: number;
  experimentName: string;
  circleTargetPeriod: number;   // ms
  circleTargetRadius: number;   // 0–0.5
  // ── Reaching task ────────────────────────────────────────────────────
  /** Target X in stage units (0–1). Default 0.5 (centered horizontally). */
  reachingTargetX: number;
  /** Target Y in stage units (0–1). Default 0.2 (upper area). */
  reachingTargetY: number;
  /** Starting cursor X. Default 0.5 (same column as target). */
  reachingStartX: number;
  /** Starting cursor Y. Default 0.8 (lower area). */
  reachingStartY: number;
  /** Max distance (stage units) for "reached" detection. Default 0.05. */
  reachingThreshold: number;
  /** Number of baseline (no-rotation) trials at the start. Default 5. */
  reachingPreTrials: number;
  /** Number of rotation (adaptation) trials. Default 10. */
  reachingRotationTrials: number;
  /** Number of post-rotation (washout) trials. Default 5. */
  reachingPostTrials: number;
  /** Visuomotor rotation angle in degrees (applied during rotation phase). Default 15. */
  reachingRotationDeg: number;
  // ── Display mode ─────────────────────────────────────────────────────
  /**
   * Display mode applied to the stage during trial execution. Defaults to
   * `'avgOnly'` (legacy behavior). Per-trial overrides are possible via
   * {@link ExecuteTrialRule.displayMode}.
   */
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
  // ── Participant gating ───────────────────────────────────────────────
  /**
   * Median LiveKit RTT (ms) cutoff for the pre-experiment latency check on
   * the participant consent screen. Participants whose median RTT exceeds
   * this value cannot proceed. Default 100.
   */
  latencyThresholdMs: number;
};

export function randomSharedPhaseSeed(): number {
  return Math.floor(Math.random() * 2147483647) + 1;
}

export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = {
  taskType: 'task9',
  trialCount: 5,
  trialDurationSeconds: 30,
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
  cursorControlBaselineTrials: 3,
  cursorControlAdaptationTrials: 0,
  cursorControlSharedTrials: 5,
  cursorControlWashoutTrials: 2,
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
};

// ---------------------------------------------------------------------------
// Rule types
// ---------------------------------------------------------------------------

export type WaitForParticipantsRule = {
  type: 'waitForParticipants';
  minParticipants: number;
  timeoutMinutes: number;
  /** Display mode during wait phase */
  waitPhaseDisplayMode?: DisplayMode;
  /** Task mode during wait phase (e.g. target-tracking for triangle targets) */
  waitPhaseTaskMode?: TaskMode;
  /** Cursor visibility during wait phase */
  waitPhaseHideCursor?: boolean;
  /** Show the center countdown / participant count during wait. Defaults to true. */
  showCountdown?: boolean;
  /** Keep waiting until enough participants are present instead of timing out. */
  waitIndefinitely?: boolean;
  /** End the agent instead of proceeding with fewer participants after timeout. */
  endOnTimeout?: boolean;
  /** After enough participants join, wait for an admin Start action before continuing. */
  waitForAdminStart?: boolean;
  /** For Task1: after enough participants join, wait until all required participants press START. */
  waitForParticipantStart?: boolean;
  /** Maximum time to wait after the START buttons appear. */
  participantStartTimeoutSeconds?: number;
  /** Alternate broadcast messages during wait */
  alternatingMessages?: {
    messages: string[];
    intervalMs: number;
  };
  /**
   * Target on/off cycling during the wait phase. When both durations are set
   * (and `waitPhaseTaskMode === 'target-tracking'`), the target is shown for
   * `targetCycleActiveMs` then hidden for `targetCycleRestMs`, repeating until
   * the wait phase ends. The bottom alternating message is swapped for
   * {@link restMessage} during the rest period. Omitting either field falls
   * back to the legacy behavior of continuously visible targets.
   */
  targetCycleActiveMs?: number;
  targetCycleRestMs?: number;
  /**
   * Bottom-position message shown during the rest period of the target cycle.
   * Has no effect unless `targetCycleActiveMs` and `targetCycleRestMs` are set.
   */
  restMessage?: string;
};

export type ShowInstructionRule = {
  type: 'showInstruction';
  text: string;
  /** How long the agent waits/blocks on this rule (read time, ms). */
  durationMs: number;
  /**
   * Optional override for how long the broadcast message stays visible on
   * clients. Defaults to {@link durationMs}. Set by `wrapInstructionWithYesNo`
   * (in `experiments/common-flow.ts`) so the instruction text remains on
   * screen across the Yes/No confirmation phase that immediately follows it.
   * The client replaces any existing broadcast in the same slot when a new
   * one arrives, so the next instruction cleanly supersedes this one.
   */
  broadcastDurationMs?: number;
  waitForDuration: boolean;
  /** Optional client-local pages advanced independently with Next. */
  instructionPages?: string[];
  /** Wait for participants to click a client-side Next button before proceeding. */
  waitForNext?: boolean;
  /** Optional label for the waitForNext button. Defaults to "Next". */
  nextButtonLabel?: string;
  /** Minimum time before the Next button appears. Defaults to 1000ms. */
  nextMinDisplayMs?: number;
  displayMode?: DisplayMode;
  hideCursor?: boolean;
  /** Broadcast position: center (default) or bottom */
  position?: 'center' | 'bottom';
  /** Show/hide click-area overlay when this instruction is displayed */
  setClickAreaOverlay?: boolean;
  /** Enable/disable virtual cursor mode when this instruction is displayed */
  setUseVirtualCursor?: boolean;
  /** Ask clients to release pointer lock when this instruction is displayed. */
  unlockPointerLock?: boolean;
};

export type SetDisplayModeRule = {
  type: 'setDisplayMode';
  mode: DisplayMode;
};

export type SetTaskModeRule = {
  type: 'setTaskMode';
  taskMode: TaskMode;
};

export type ShowYesNoAreasRule = {
  type: 'showYesNoAreas';
  requiredArea: 'yes' | 'no' | 'any';
  requiredRatio: number;
  timeoutSeconds: number;
};

export type HideYesNoAreasRule = {
  type: 'hideYesNoAreas';
};

export type WaitRule = {
  type: 'wait';
  durationSeconds: number;
};

export type SetCursorVisibilityRule = {
  type: 'setCursorVisibility';
  hideCursor: boolean;
};

export type EnableVirtualCursorRule = {
  type: 'enableVirtualCursor';
  timeoutSeconds: number;
};

export type ResetVirtualCursorPositionRule = {
  type: 'resetVirtualCursorPosition';
};

export type SetClickAreaOverlayRule = {
  type: 'setClickAreaOverlay';
  show: boolean;
};

export type StartRecordingRule = {
  type: 'startRecording';
  experimentName: string;
  trialNumber: number;
};

export type StopRecordingAndUploadRule = {
  type: 'stopRecordingAndUpload';
  /** Max seconds to wait for upload completion */
  timeoutSeconds: number;
};

export type ExecuteTrialRule = {
  type: 'executeTrial';
  trialNumber: number;
  totalTrials: number;
  durationSeconds: number;
  taskType: ExperimentTaskType;
  experimentName: string;
  circleTargetPeriod?: number;
  circleTargetRadius?: number;
  /**
   * Visuomotor rotation in degrees applied to the participant's cursor input
   * during this trial. Used by the reaching task to introduce/remove rotation
   * across trial phases.
   */
  cursorRotationDeg?: number;
  /**
   * Per-trial override of the stage display mode. When omitted, the agent
   * falls back to {@link ExperimentConfig.trialDisplayMode}, then to `'avgOnly'`.
   * Lets advanced experiments vary which cursors are visible across trials.
   */
  displayMode?: DisplayMode;
  sharedPhase?: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
  sharedVisualGain?: number;
  sharedDisturbance?: Record<string, unknown>;
  skipRecording?: boolean;
  recordingUploadTimeoutSeconds?: number;
};

export type EndSessionRule = {
  type: 'endSession';
  completionUrl?: string;
};

/**
 * Randomly assign current participants to N groups (as evenly as possible)
 * and broadcast the assignments. `groupCount: 1` merges everyone into a
 * single group, effectively clearing groupings.
 */
export type ComputeGroupsRule = {
  type: 'computeGroups';
  groupCount: number;
};

export type AgentRule =
  | WaitForParticipantsRule
  | ShowInstructionRule
  | SetDisplayModeRule
  | SetTaskModeRule
  | ShowYesNoAreasRule
  | HideYesNoAreasRule
  | WaitRule
  | SetCursorVisibilityRule
  | EnableVirtualCursorRule
  | ResetVirtualCursorPositionRule
  | SetClickAreaOverlayRule
  | StartRecordingRule
  | StopRecordingAndUploadRule
  | ExecuteTrialRule
  | ComputeGroupsRule
  | EndSessionRule;

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped';

export type AgentState = {
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
  recordingStatus?: 'idle' | 'recording' | 'queued' | 'uploading' | 'uploaded' | 'error';
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

// ---------------------------------------------------------------------------
// Describe a rule in human-readable text
// ---------------------------------------------------------------------------

export function describeRule(rule: AgentRule): string {
  switch (rule.type) {
    case 'waitForParticipants': {
      const alt = rule.alternatingMessages ? ' (with alternating messages)' : '';
      const countdown = rule.showCountdown === false ? ' [no countdown]' : '';
      const unlimited = rule.waitIndefinitely ? ' [no timeout]' : '';
      const manual = rule.waitForAdminStart ? ' [admin start]' : '';
      const phase = rule.waitPhaseTaskMode ? ` [task: ${rule.waitPhaseTaskMode}]` : '';
      const cycle =
        rule.targetCycleActiveMs && rule.targetCycleRestMs
          ? ` [cycle: ${rule.targetCycleActiveMs / 1000}s on / ${rule.targetCycleRestMs / 1000}s rest]`
          : '';
      return `Wait for ${rule.minParticipants} participants (timeout: ${rule.timeoutMinutes} min)${phase}${cycle}${countdown}${unlimited}${manual}${alt}`;
    }
    case 'showInstruction': {
      const extras: string[] = [];
      if (rule.displayMode !== undefined) extras.push(`mode: ${rule.displayMode}`);
      if (rule.hideCursor !== undefined) extras.push(rule.hideCursor ? 'hide cursor' : 'show cursor');
      if (rule.position === 'bottom') extras.push('bottom');
      if (rule.setClickAreaOverlay !== undefined) extras.push(rule.setClickAreaOverlay ? 'show overlay' : 'hide overlay');
      if (rule.setUseVirtualCursor !== undefined) extras.push(rule.setUseVirtualCursor ? 'virtual cursor ON' : 'virtual cursor OFF');
      if (rule.unlockPointerLock) extras.push('unlock pointer');
      if (rule.waitForNext) extras.push('wait for Next');
      const suffix = extras.length > 0 ? ` [${extras.join(', ')}]` : '';
      return `Show instruction: "${rule.text.substring(0, 50)}${rule.text.length > 50 ? '...' : ''}" (${rule.durationMs / 1000}s)${suffix}`;
    }
    case 'setDisplayMode':
      return `Set display mode: ${rule.mode}`;
    case 'setTaskMode':
      return `Set task mode: ${rule.taskMode}`;
    case 'showYesNoAreas':
      return `Show Yes/No areas → wait for '${rule.requiredArea}' (${Math.round(rule.requiredRatio * 100)}%, timeout: ${rule.timeoutSeconds}s)`;
    case 'hideYesNoAreas':
      return 'Hide Yes/No areas';
    case 'wait':
      return `Wait ${rule.durationSeconds} seconds`;
    case 'setCursorVisibility':
      return rule.hideCursor ? 'Hide cursors' : 'Show cursors';
    case 'enableVirtualCursor':
      return `Enable virtual cursor (timeout: ${rule.timeoutSeconds}s)`;
    case 'resetVirtualCursorPosition':
      return 'Reset virtual cursor position';
    case 'setClickAreaOverlay':
      return rule.show ? 'Show click area overlay' : 'Hide click area overlay';
    case 'startRecording':
      return `Start recording: "${rule.experimentName}" trial #${rule.trialNumber}`;
    case 'stopRecordingAndUpload':
      return `Stop recording & upload (timeout: ${rule.timeoutSeconds}s)`;
    case 'executeTrial': {
      const rot = rule.cursorRotationDeg ?? 0;
      const rotInfo = rot !== 0 ? `, rot ${rot}°` : '';
      const modeInfo = rule.displayMode ? `, mode=${rule.displayMode}` : '';
      return `Execute trial ${rule.trialNumber}/${rule.totalTrials} (${rule.durationSeconds}s, ${rule.taskType}${rotInfo}${modeInfo})`;
    }
    case 'computeGroups':
      return rule.groupCount <= 1
        ? 'Merge all participants into 1 group'
        : `Randomly split participants into ${rule.groupCount} groups`;
    case 'endSession':
      return 'End session';
  }
}
