import {
  Room,
  RoomEvent,
  DataPacket_Kind,
  type Participant,
} from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import AgentAdmin from './AgentAdmin.js';
import AdminAgentControls from './AdminAgentControls.js';
import {
  classifyParticipantTermination,
  getParticipantStartButtonLabel,
  getParticipantStartPrompt,
  getPreExperimentReturnNotice,
  INSTRUCTION_BACK_LABEL,
  PARTICIPANT_WAITING_CURSOR_NOTICE,
  submitParticipantStart,
} from './termination-copy.js';
import {
  advanceTask9SharedTargetParams,
  getTask9SharedCursorFill,
  isTask9CompletionMessage,
  shouldShowTask9CompletionScore,
  shouldShowTask9QuestionnaireScore,
  shouldShowTask9SharedFeedback,
  type Task9Acquisition,
} from './experiments/task9/point-to-point.js';
import { getInitialExperimentTaskType } from './admin-agent-controls-config-sync.js';
import { TaskStage, type P5Dot, type P5Line, type P5Target, type P5Guide, type P5YesNo, type ExperimentTaskType } from './experiments/TaskStage';
import {
  getSketchByExperimentTask,
  getSketchByTaskMode,
} from './experiments/registry';
import {
  CONSENT_DATA_COLLECTION_ITEMS,
  SHARED_CONTRIBUTION_OPTIONS,
  SHARED_CONTRIBUTION_OPTION_GAP_PX,
  SHARED_CONTRIBUTION_OPTION_MIN_HEIGHT_PX,
  SHARED_CONTRIBUTION_PANEL_MAX_WIDTH_PX,
  SHARED_CONTRIBUTION_CONSENT_COPY,
  SHARED_CONTRIBUTION_SUBMIT_LABEL,
  deliverSharedContributionResponse,
  getSharedContributionInputId,
  getSharedContributionQuestion,
  isSharedContributionSelected,
} from './shared-contribution';
import { finishAdminSession, finishParticipantSession } from './completion-disconnect';
import { describeRecordingStorage } from './recording-storage';
import { getInstructionImageAlt, getInstructionImageSrc } from './instruction-images';
import { formatTimestampForFilename } from './filename-time';
import { shouldRequireImmediatePointerLockRecovery } from './pointer-lock-recovery';
import { waitForPointerLockRelease } from './pointer-lock-release';
import {
  getWaitingTargetFill,
  getWaitingTargetPosition,
  shouldResetParticipantStartConfirmation,
  shouldShowCursorControlWaitingPreview,
} from './waiting-target';
import { SequentialUploadQueue } from './recording-upload-queue';

const LOCAL_SUPABASE_URL = typeof import.meta.env.VITE_LOCAL_SUPABASE_URL === 'string'
  ? import.meta.env.VITE_LOCAL_SUPABASE_URL
  : 'http://127.0.0.1:54321';
const LOCAL_SUPABASE_ANON_KEY = typeof import.meta.env.VITE_LOCAL_SUPABASE_ANON_KEY === 'string'
  ? import.meta.env.VITE_LOCAL_SUPABASE_ANON_KEY
  : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjQxMDI0NDQ4MDB9.zAf0gwczfDgC88DnAowpMA6xJxOzsbU8mhePGDi8VF4';
const REMOTE_SUPABASE_URL = typeof import.meta.env.VITE_SUPABASE_URL === 'string'
  ? import.meta.env.VITE_SUPABASE_URL
  : 'https://nwswppwpgarmswslkrxz.supabase.co';
const REMOTE_SUPABASE_ANON_KEY = typeof import.meta.env.VITE_SUPABASE_ANON_KEY === 'string'
  ? import.meta.env.VITE_SUPABASE_ANON_KEY
  : 'sb_publishable_dTKIKCqm4Dhq5wiCLAQdJw_FBiHbsGv';
const USE_REMOTE_SUPABASE = import.meta.env.PROD || import.meta.env.VITE_SUPABASE_USE_REMOTE_IN_DEV === '1';
const SUPABASE_URL = USE_REMOTE_SUPABASE ? REMOTE_SUPABASE_URL : LOCAL_SUPABASE_URL;
const SUPABASE_ANON_KEY = USE_REMOTE_SUPABASE ? REMOTE_SUPABASE_ANON_KEY : LOCAL_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const RECORDING_STORAGE = describeRecordingStorage(USE_REMOTE_SUPABASE, SUPABASE_URL);

type RecordingStatusPayload = {
  status: 'recording' | 'queued' | 'uploading' | 'uploaded' | 'error';
  experimentName: string;
  trialNumber: number;
};

async function postRecordingStatusWithRetry(
  serverUrl: string,
  payload: RecordingStatusPayload,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/agent/recording-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Recording status HTTP ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

type CursorState = {
  identity: string;
  displayName: string;
  color: string;
  x: number;
  y: number;
  updatedAt: number;
  isLocal: boolean;
  hash: number;
};

type TokenResponse = {
  token: string;
  url: string;
  identity: string;
  room: string;
  isAdmin: boolean;
  expiresIn: number;
};

type DisplayMode =
  | 'all-without-avg'
  | 'all-with-avg-lines'
  | 'all-with-avg-no-lines'
  | 'avgOnly'
  | 'self'
  | 'self-with-avg';

type GroupAssignmentsState = {
  assignments: Record<string, number>;
  groupCount: number;
};

type ControlMessage =
  | { type: 'hello'; version: number }
  | { type: 'state'; payload: {
      displayMode: DisplayMode;
      hideCursor: boolean;
      targetVisible?: boolean;
      useVirtualCursor?: boolean;
      taskMode?: TaskMode;
      experimentTaskType?: ExperimentTaskType | null;
      yesNoAreas?: YesNoAreasState;
      showClickAreaOverlay?: boolean;
      guideTrackingRunning?: boolean;
      joystickMultiplier?: number;
      participantCursorSize?: number;
      averageCursorSize?: number;
      circleTargetSize?: number;
      randomTargetSize?: number;
      groupAssignments?: GroupAssignmentsState;
      task9SharedFeedbackEnabled?: boolean;
      // ── Reaching task synchronization (added 2026-05-15) ──────────────
      // Including these here lets a mid-join participant pick up the
      // current rotation/offset for an in-progress reaching trial without
      // waiting for the next setCursorRotation/setAvgCursorOffset broadcast.
      cursorRotationDeg?: number;
      avgCursorOffset?: { x: number; y: number };
      // ── Guide tracking radius (added 2026-05-15) ──────────────────────
      // Without this, the admin's radius (set via AgentAdmin's experiment
      // config) wouldn't reach a mid-join participant for guide rendering.
      circleTargetRadius?: number;
    } }
  | { type: 'setMode'; mode: DisplayMode; timestamp: number }
  | { type: 'setGroupAssignments'; assignments: Record<string, number>; groupCount: number; timestamp: number }
  | { type: 'setHideCursor'; hideCursor: boolean; timestamp: number }
  | { type: 'setTargetVisibility'; visible: boolean; timestamp: number }
  | { type: 'setUseVirtualCursor'; useVirtualCursor: boolean; timestamp: number }
  | { type: 'task7PointerLockRecovery'; identities: string[]; timestamp: number }
  | { type: 'complete'; url?: string; timestamp: number }
  | { type: 'participantTermination'; disposition: 'return-no-payment' | 'partner-compensation-review'; reason: string; elapsedSeconds: number; timestamp: number }
  | { type: 'setYesNoAreas'; yesNoAreas: YesNoAreasState; timestamp: number }
  | { type: 'setClickAreaOverlay'; showClickAreaOverlay: boolean; timestamp: number }
  | { type: 'unlockPointerLock'; timestamp: number }
  | { type: 'resetVirtualCursorPosition'; timestamp: number }
  | { type: 'setVirtualCursorPosition'; x: number; y: number; timestamp: number }
  | { type: 'setCursorRotation'; degrees: number; timestamp: number }
  | { type: 'setAvgCursorOffset'; x: number; y: number; timestamp: number }
  | { type: 'kick'; targetIdentity: string; timestamp: number }
  | { type: 'setGuideTrackingRunning'; guideTrackingRunning: boolean; radius?: number; timestamp: number }
  | { type: 'setJoystickMultiplier'; multiplier: number; timestamp: number }
  | { type: 'resetMobileCursorPosition'; timestamp: number }
  | { type: 'setCursorSize'; participantCursorSize: number; averageCursorSize: number; timestamp: number }
  | { type: 'setTargetSize'; circleTargetSize: number; randomTargetSize: number; timestamp: number }
  | { type: 'agentStartRecording'; experimentName: string; trialNumber: number; taskType?: string; displayMode?: DisplayMode; participantCount?: number; experimentConfig?: Record<string, unknown>; sourceOrigin?: string; timestamp: number }
  | { type: 'agentStopRecording'; experimentName: string; trialNumber: number; sourceOrigin?: string; timestamp: number }
  | { type: 'setRecordingMetadata'; trialMetadata: Record<string, unknown>; timestamp: number }
  | { type: 'agentStartCircleTarget'; period: number; radius: number; durationMs: number; timestamp: number }
  | { type: 'agentStopCircleTarget'; timestamp: number }
  | { type: 'startSketchTrajectory'; params: Record<string, unknown>; timestamp: number }
  | { type: 'stopSketchTrajectory'; timestamp: number }
  | { type: 'startSketchHitDetector'; params: Record<string, unknown>; timestamp: number }
  | { type: 'stopSketchHitDetector'; timestamp: number }
  | { type: 'setSharedCursorControl'; enabled: boolean; phase?: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout'; matrix?: number[]; visualGain?: number; disturbance?: CursorControlDisturbance; timestamp: number }
  | { type: 'setTask9SharedFeedback'; enabled: boolean; timestamp: number }
  | { type: 'showSharedCursorQuestionnaire'; trialNumber: number; kind?: 'legacy' | 'contribution'; timestamp: number }
  | { type: 'hideSharedCursorQuestionnaire'; timestamp: number };

const KICK_COMPLETION_URL = 'https://app.prolific.com/submissions/complete?cc=CCJ6W1JJ';

// Hard deadline for the Informed Consent flow. The participant must complete
// the internet-speed check + click "I Agree and Continue" within this many
// seconds of landing on the consent screen; otherwise they are auto-withdrawn
// and asked to return their Prolific submission. The experiment runs in real
// time and cannot accommodate slow stragglers.
const CONSENT_DEADLINE_SECONDS = 240;

// During the experiment, treat a participant as withdrawn if there is no cursor
// input for this long. The other participant then sees the standard withdrawal
// notice and the session ends without reward.
const PARTICIPANT_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;

function isCursorControlExperimentTask(type: ExperimentTaskType | null | undefined): boolean {
  return type === 'cursor-control-20260706' || type === 'task8' || type === 'task9';
}

function rotatePointCounterClockwise90AroundCenter(point: { x: number; y: number }): { x: number; y: number } {
  return { x: 1 - point.y, y: point.x };
}

function rotatePointClockwise90AroundCenter(point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.y, y: 1 - point.x };
}

type BroadcastMessage = {
  type: 'broadcast';
  text: string;
  durationMs?: number;
  severity?: 'info' | 'warning' | 'error';
  position?: 'center' | 'bottom' | 'top';
  instructionPages?: string[];
  instructionId?: string;
  waitForNext?: boolean;
  nextButtonLabel?: string;
  nextMinDisplayMs?: number;
  timestamp: number;
};

type ChatMessage = {
  type: 'chat';
  from: string;
  text: string;
  timestamp: number;
};

type StatsMessage = {
  type: 'stats';
  identity: string;
  rttMs: number | null;
  isPointerLocked: boolean;
  isUsingVirtualCursor: boolean;
  timestamp: number;
};

type SharedCursorResponseMessage = {
  type: 'sharedCursorResponse';
  identity: string;
  trialNumber: number;
  questionnaireKind: 'legacy' | 'contribution';
  agency?: number;
  partnership?: number;
  contribution?: number;
  timestamp: number;
};

type SharedTrackingLifecycleMessage = {
  type: 'sharedTrackingStart' | 'sharedTrackingComplete';
  identity: string;
  trialKey: string;
  timestamp: number;
};

type EscPressedMessage = {
  type: 'escPressed';
  identity: string;
  trialKey: string;
  phase: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
  cursorX: number;
  cursorY: number;
  timestamp: number;
};

type ParticipantLogEvent = {
  id: string;
  identity: string;
  displayName: string;
  eventType: 'joined' | 'left';
  timestamp: number;
};

type LiveKitParticipant = {
  identity: string;
  displayName: string;
  joinedAt: number;
  metadata?: string;
};

type TaskMode = 'target-tracking' | 'manual-instruction' | 'circle-target-tracking' | 'guide-tracking' | 'random-target-tracking' | 'reaching' | 'shared-single-cursor';

type TaskControlMessage = {
  type: 'taskControl';
  taskMode: TaskMode;
  taskType?: ExperimentTaskType;
  timestamp: number;
};

type CursorControlDisturbanceParams = {
  gainA: number;
  gainB: number;
  rotationDeg: number;
};

type CursorControlDisturbance = {
  enabled?: boolean;
  type?: string;
  phase?: string;
  rampStartSeconds?: number;
  rampDurationSeconds?: number;
  rampShape?: string;
  participantStart?: CursorControlDisturbanceParams[];
  participantEnd?: CursorControlDisturbanceParams[];
  participantTargets?: CursorControlDisturbanceParams[];
};

type TargetState = {
  x: number;
  y: number;
  shape: 'triangle' | 'circle' | 'square';
  /** Optional CSS color string. When omitted, render uses task-mode default. */
  color?: string;
  trajectoryParams?: Record<string, unknown>;
  trajectoryElapsedMs?: number;
  trajectoryReceivedAt?: number;
};

type YesNoAreasState = {
  visible: boolean;
  yesPosition: { x: number; y: number };
  noPosition: { x: number; y: number };
};

type TargetMessage = {
  type: 'target';
  x: number;
  y: number;
  shape: 'triangle' | 'circle' | 'square';
  /** Optional CSS color (e.g. 'yellow', '#ef4444'). Reaching uses this for
   *  yellow→red transition. Other tasks omit it. */
  color?: string;
  trajectoryParams?: Record<string, unknown>;
  trajectoryElapsedMs?: number;
  timestamp: number;
};

type AdminEvent =
  | { timestamp: number; type: 'displayModeChanged'; mode: DisplayMode }
  | { timestamp: number; type: 'recordingStarted' }
  | { timestamp: number; type: 'recordingStopped' }
  | { timestamp: number; type: 'sessionEnded'; completionUrl: string }
  | { timestamp: number; type: 'broadcast'; text: string; duration: number; severity: 'info' | 'warning' | 'error' }
  | { timestamp: number; type: 'taskModeChanged'; taskMode: TaskMode }
  | { timestamp: number; type: 'cursorVisibilityChanged'; hideCursor: boolean }
  | { timestamp: number; type: 'targetShown' }
  | { timestamp: number; type: 'targetHidden' }
  | { timestamp: number; type: 'task9ScoreAcquired'; trialKey: string; trialNumber: number; phase: string; score: number; sequence: number; targetIndex: number; nextTargetIndex: number }
  | { timestamp: number; type: 'virtualCursorModeChanged'; useVirtualCursor: boolean }
  | { timestamp: number; type: 'sharedCursorResponse'; identity: string; trialNumber: number; questionnaireKind: 'legacy' | 'contribution'; agency?: number; partnership?: number; contribution?: number }
  | { timestamp: number; type: 'sharedTrackingStart' | 'sharedTrackingComplete'; identity: string; trialKey: string; participantTimestamp: number }
  | { timestamp: number; type: 'escPressed'; identity: string; trialKey: string; phase: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout'; cursorX: number; cursorY: number; participantTimestamp: number };

type AdminEventExport = AdminEvent & { t: number };

type RecordingRecord = {
  id: string;
  experiment_name: string;
  trial_number: number;
  room_name: string;
  start_time: number;
  end_time: number | null;
  frame_rate: number;
  total_frames: number;
  created_at: string;
  /** Optional group fields (added in Phase 4). Older recordings won't have these. */
  group_assignments?: Record<string, number>;
  group_count?: number;
  /** Recording-context columns (added 2026-05-06). Older rows: empty / 'avgOnly' / 0. */
  task_type?: string;
  display_mode?: string;
  participant_count?: number;
  experiment_config?: Record<string, unknown>;
  trial_metadata?: Record<string, unknown>;
  session_json?: RecordingSession;
};

/** Distinct colors per group ID, used for both replay and live admin/viewer rendering. */
const GROUP_COLORS = ['#1d4ed8', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#db2777'];
const GROUP_COLOR_FALLBACK = '#475569';
function colorForGroup(groupId: number): string {
  return GROUP_COLORS[groupId] ?? GROUP_COLOR_FALLBACK;
}

const SHARED_QUESTION_OPTIONS = [
  { value: 0, label: '0: Not at all' },
  { value: 1, label: '1: Not much' },
  { value: 2, label: '2: A little' },
  { value: 3, label: '3: Very much' },
];

function SharedQuestion({
  question,
  value,
  onChange,
}: {
  question: React.ReactNode;
  value: number | null;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset className="shared-questionnaire__question">
      <legend>{question}</legend>
      <div className="shared-questionnaire__options">
        {SHARED_QUESTION_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`shared-questionnaire__option${value === option.value ? ' selected' : ''}`}
          >
            <input
              type="radio"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SharedContributionQuestion({
  question,
  value,
  onChange,
}: {
  question: string;
  value: number | null;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset className="shared-questionnaire__question shared-questionnaire__contribution">
      <legend>{question}</legend>
      <div
        className="shared-questionnaire__contribution-options"
        style={{ gap: `${SHARED_CONTRIBUTION_OPTION_GAP_PX}px` }}
      >
        {SHARED_CONTRIBUTION_OPTIONS.map((option) => (
          <label
            key={option.value}
            htmlFor={getSharedContributionInputId(option.value)}
            className={`shared-questionnaire__contribution-option${value === option.value ? ' selected' : ''}`}
            style={{ minHeight: `${SHARED_CONTRIBUTION_OPTION_MIN_HEIGHT_PX}px` }}
          >
            <input
              id={getSharedContributionInputId(option.value)}
              type="radio"
              name="shared-contribution"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              style={{ width: '18px', height: '18px' }}
            />
            <span className="shared-questionnaire__contribution-number">{option.value}</span>
            {'label' in option && (
              <span className="shared-questionnaire__contribution-label">{option.label}</span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RichInstructionText({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: text }} />;
}

function StageBottomInstruction({
  message,
  isAdmin,
  identity,
  tokenServerUrl,
  onRequestPointerLock,
  isPointerLocked,
  allParticipantsPointerLocked,
  suppressLockWaitMessage,
  experimentTaskType,
}: {
  message: BroadcastMessage & { id: string };
  isAdmin: boolean;
  identity?: string | null;
  tokenServerUrl: string;
  onRequestPointerLock?: () => void;
  isPointerLocked?: boolean;
  allParticipantsPointerLocked?: boolean;
  suppressLockWaitMessage?: boolean;
  experimentTaskType?: ExperimentTaskType | null;
}) {
  const [canProceed, setCanProceed] = useState(!message.waitForNext);
  const [pageIndex, setPageIndex] = useState(0);
  const [pagesComplete, setPagesComplete] = useState(false);
  const pages = message.instructionPages?.length ? message.instructionPages : [message.text];
  const isLastPage = pageIndex >= pages.length - 1;
  const isWithdrawalNotice = pages[pageIndex].startsWith('The other participant has withdrawn from the task.');
  const task7InstructionImageSrc = getInstructionImageSrc(pages[pageIndex], experimentTaskType);
  const showTask7TrackingInstructionImage = task7InstructionImageSrc !== null;

  useEffect(() => {
    setPageIndex(0);
    setPagesComplete(false);
  }, [message.id]);

  useEffect(() => {
    if (!message.waitForNext) {
      setCanProceed(true);
      return;
    }
    setCanProceed(false);
    const timer = window.setTimeout(() => {
      setCanProceed(true);
    }, message.nextMinDisplayMs ?? 1000);
    return () => window.clearTimeout(timer);
  }, [message.id, message.nextMinDisplayMs, message.waitForNext, pageIndex]);

  const handleNext = async () => {
    if (!isLastPage) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (!message.instructionId || !identity) return;
    setPagesComplete(true);
    try {
      const serverUrl = tokenServerUrl.replace(/\/$/, '');
      const response = await fetch(`${serverUrl}/agent/instruction-next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, instructionId: message.instructionId }),
      });
      if (!response.ok) {
        throw new Error(`Instruction completion failed: ${response.status}`);
      }
    } catch (err) {
      console.warn('Failed to report instruction Next click', err);
      setPagesComplete(false);
    }
  };

  const handlePrevious = () => {
    if (pageIndex > 0) setPageIndex((current) => current - 1);
  };

  if (!message.waitForNext) {
    return (
      <div className={`stage-bottom-instruction${isWithdrawalNotice ? ' stage-bottom-instruction--withdrawal' : ''}`}>
        <div className="stage-bottom-instruction__text"><RichInstructionText text={pages[pageIndex]} /></div>
      </div>
    );
  }

  if (pagesComplete) {
    if (!isPointerLocked) {
      return (
        <div className="stage-pointer-lock-prompt">
          <button
            type="button"
            className="stage-pointer-lock-prompt__target"
            onClick={onRequestPointerLock}
            aria-label="Lock cursor for virtual cursor mode"
          >
            <span />
          </button>
          <div className="stage-pointer-lock-prompt__text">
            Click the center of the circle above to switch to the task cursor.
          </div>
        </div>
      );
    }
    if (allParticipantsPointerLocked || suppressLockWaitMessage) {
      return null;
    }
    return (
      <div className="stage-lock-wait-message">
        Waiting for the other participant...
      </div>
    );
  }

  return (
    <>
      <div className={`stage-instruction-dialog${showTask7TrackingInstructionImage ? ' stage-instruction-dialog--with-image' : ''}`}>
        {showTask7TrackingInstructionImage && (
          <img
            src={task7InstructionImageSrc ?? undefined}
            alt={getInstructionImageAlt(pages[pageIndex])}
            className="stage-instruction-dialog__image"
          />
        )}
        <div className="stage-instruction-dialog__text"><RichInstructionText text={pages[pageIndex]} /></div>
        <div className="stage-instruction-dialog__count">{pageIndex + 1}/{pages.length}</div>
      </div>
      {!isAdmin && canProceed && (
        <button
          type="button"
          className="stage-bottom-instruction__next"
          onClick={handleNext}
          disabled={isLastPage && !identity}
        >
          {message.nextButtonLabel ?? 'Next'}
        </button>
      )}
      {!isAdmin && pageIndex > 0 && (
        <button
          type="button"
          className="stage-bottom-instruction__previous"
          onClick={handlePrevious}
        >
          {INSTRUCTION_BACK_LABEL}
        </button>
      )}
    </>
  );
}

type CursorSnapshot = {
  identity: string;
  displayName: string;
  x: number;
  y: number;
  hash: number;
  isLocal: boolean;
  color: string;
  rttMs?: number | null;
  /** Group assignment at the moment of capture (group experiments only). */
  groupId?: number;
};

type FrameSnapshot = {
  timestamp: number;
  frameNumber: number;
  cursors: CursorSnapshot[];
  average: { x: number; y: number } | null;
  target: { x: number; y: number; shape: 'triangle' | 'circle' | 'square' } | null;
  /** Target each participant saw during independently gated Task 6 trials. */
  participantTargets?: Record<string, { x: number; y: number; shape: 'circle' } | null>;
  /** Per-group average cursor positions for group experiments. Empty for single-group. */
  groupAverages?: Record<number, { x: number; y: number }>;
};

type RecordingSession = {
  startTime: number;
  endTime?: number;
  roomName: string;
  frames: FrameSnapshot[];
  frameRate: number;
  broadcastMessages: Array<BroadcastMessage & { id: string }>;
  events: AdminEventExport[];
  /** Snapshot of groupAssignments at the moment recording started (group experiments only). */
  groupAssignments?: GroupAssignmentsState;
  // ── Recording context (captured at session start, used for filename + DB row) ──
  /** Experiment name (session-level identifier — possibly includes timestamp/N). */
  experimentName: string;
  /** Trial number (1-indexed). */
  trialNumber: number;
  /** Task type during this recording (`'reaching'`, `'circle-target-tracking'`, …). */
  taskType: string;
  /** Cursor display mode applied during the trial. */
  displayMode: DisplayMode;
  /** Total non-admin participants in the room when recording started. */
  participantCount: number;
  /** Full Agent configuration used to generate this experiment. */
  experimentConfig?: Record<string, unknown>;
  /** Runtime parameters used for this individual trial. */
  trialMetadata?: Record<string, unknown>;
};

const RECORDINGS_LIST_SELECT = [
  'id',
  'experiment_name',
  'trial_number',
  'room_name',
  'start_time',
  'end_time',
  'frame_rate',
  'total_frames',
  'created_at',
  'group_assignments',
  'group_count',
  'task_type',
  'display_mode',
  'participant_count',
  'experiment_config',
  'trial_metadata',
].join(',');

function isMissingDatabaseColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string; details?: string };
  const text = `${candidate.message ?? ''} ${candidate.details ?? ''}`.toLowerCase();
  return candidate.code === '42703'
    || (text.includes('column') && text.includes('does not exist'))
    || (text.includes('could not find') && text.includes('column') && text.includes('schema cache'));
}

/**
 * Filename used when downloading a recording as JSON. The filename is
 * underscore-delimited so consumers can `split('_')` it back into parts:
 *   `{date}_{taskType}_{participantCount}_{trialNumber}_{displayMode}.json`
 *
 * Date is Japan Standard Time `YYYY-MM-DDTHH-MM-SS` (colons replaced with
 * hyphens — matches the experiment name format). All five fields are
 * guaranteed not to contain underscores, so a single `split('_')` is exact.
 */
function buildRecordingFilename(input: {
  startTime: number;
  taskType?: string | null;
  participantCount?: number | null;
  trialNumber: number;
  displayMode?: string | null;
}): string {
  const ts = formatTimestampForFilename(input.startTime);
  const task = input.taskType && input.taskType.length > 0 ? input.taskType : 'unknown';
  const count = input.participantCount ?? 0;
  const mode = input.displayMode && input.displayMode.length > 0 ? input.displayMode : 'unknown';
  return `${ts}_${task}_${count}_${input.trialNumber}_${mode}.json`;
}

const VERSION = 1;
const SEND_INTERVAL_MS = 33;
const KEEPALIVE_INTERVAL_MS = 200; // Keep-alive for stationary cursors (5Hz)
const DEAD_BAND = 0.005;
const STALE_CURSOR_MS = 2000;
const CURSOR_TOPIC = 'cursor';
const CONTROL_TOPIC = 'control';
const BROADCAST_TOPIC = 'broadcast';
const CHAT_TOPIC = 'chat';
const STATS_TOPIC = 'stats';
const TARGET_TOPIC = 'target';
const WEREWOLF_TOPIC = 'werewolf';
const STATS_INTERVAL_MS = 2000;

const COMPLETION_URL = typeof import.meta.env.VITE_COMPLETION_URL === 'string'
  ? import.meta.env.VITE_COMPLETION_URL
  : 'https://app.prolific.com/submissions/complete?cc=CFL5QARB';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hashIdentity(identity: string): number {
  let hash = 0;
  for (let i = 0; i < identity.length; i += 1) {
    hash = (hash * 31 + identity.charCodeAt(i)) & 0xffff;
  }
  return hash & 0xffff;
}

function colorFromIdentity(identity: string): string {
  const hash = hashIdentity(identity);
  const random = (hash * 9301 + 49297) % 233280;
  // p5.js's hsl() parser requires an integer hue (its HSL regex uses \d{1,3});
  // a decimal hue falls through to its "unknown CSS color" branch and renders white.
  const hue = Math.round((random / 233280) * 360);
  const saturation = 70 + ((random % 30));
  const lightness = 50 + ((random % 20));
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

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

function isExperimentParticipantConnection(participant: LiveKitParticipant): boolean {
  const role = getParticipantRole(participant.metadata);
  return !participant.identity.startsWith('admin:')
    && (
      role === 'experiment-participant'
      || (role === null && !isSyntheticParticipantIdentity(participant.identity))
    );
}

type DecodedCursor = {
  version: number;
  hash: number;
  x: number;
  y: number;
  timestamp: number;
};

// Extended range for cursor coordinates: [-4.0, 5.0] mapped to [0, 65535]
// This allows cursors to go far outside the stage area without clamping
const CURSOR_RANGE_MIN = -4.0;
const CURSOR_RANGE_MAX = 5.0;
const CURSOR_RANGE_SIZE = CURSOR_RANGE_MAX - CURSOR_RANGE_MIN; // 9.0

function decodeCursorPayload(payload: Uint8Array): DecodedCursor | null {
  if (payload.byteLength < 11) {
    return null;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint8(0);
  if (version !== VERSION) {
    return null;
  }
  const hash = view.getUint16(1, false);
  // Decode from [0, 65535] to [-4.0, 5.0]
  const x = (view.getUint16(3, false) / 65535) * CURSOR_RANGE_SIZE + CURSOR_RANGE_MIN;
  const y = (view.getUint16(5, false) / 65535) * CURSOR_RANGE_SIZE + CURSOR_RANGE_MIN;
  const timestamp = view.getUint32(7, false);
  return { version, hash, x, y, timestamp };
}

function encodeCursorPayload(identity: string, x: number, y: number): Uint8Array {
  const buffer = new ArrayBuffer(11);
  const view = new DataView(buffer);
  view.setUint8(0, VERSION);
  view.setUint16(1, hashIdentity(identity), false);
  // Encode from [-4.0, 5.0] to [0, 65535]
  const clampedX = clamp(x, CURSOR_RANGE_MIN, CURSOR_RANGE_MAX);
  const clampedY = clamp(y, CURSOR_RANGE_MIN, CURSOR_RANGE_MAX);
  view.setUint16(3, Math.round(((clampedX - CURSOR_RANGE_MIN) / CURSOR_RANGE_SIZE) * 65535), false);
  view.setUint16(5, Math.round(((clampedY - CURSOR_RANGE_MIN) / CURSOR_RANGE_SIZE) * 65535), false);
  view.setUint32(7, Date.now(), false);
  return new Uint8Array(buffer);
}

// A ticker driven by a Web Worker so captures keep running at full rate
// when the admin tab is hidden/backgrounded. Browsers throttle main-thread
// timers to 1 Hz in background tabs, which collapses 60 Hz recording to ~1 Hz.
function createHighRateTicker(intervalMs: number, onTick: () => void): () => void {
  if (typeof Worker === 'undefined') {
    const id = window.setInterval(onTick, intervalMs);
    return () => window.clearInterval(id);
  }
  const src = `let tid=null;self.onmessage=e=>{if(e.data==='stop'){if(tid!==null){clearInterval(tid);tid=null;}return;}if(tid!==null)clearInterval(tid);tid=setInterval(()=>self.postMessage(0),e.data);};`;
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
  let worker: Worker | null;
  try {
    worker = new Worker(url);
  } catch (err) {
    URL.revokeObjectURL(url);
    console.warn('[Recording] Worker creation failed, falling back to setInterval', err);
    const id = window.setInterval(onTick, intervalMs);
    return () => window.clearInterval(id);
  }
  worker.onmessage = onTick;
  worker.postMessage(intervalMs);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      worker?.postMessage('stop');
      worker?.terminate();
    } catch { /* ignore */ }
    worker = null;
    URL.revokeObjectURL(url);
  };
}

// --- Random Target Tracking: Sum-of-sinusoids trajectory (Yang, Cowan & Haith, eLife 2021) ---
const RANDOM_TARGET_DURATION_S = 60; // 60-second trajectory
const RANDOM_TARGET_RAMP_S = 5; // 5-second ramp-up period

// --- Werewolf cursor types ---
type WerewolfCursorState = {
  identity: string;
  x: number;
  y: number;
  phase: number; // random phase offset for circular motion
  noisePhaseX: number; // noise phase for X axis
  noisePhaseY: number; // noise phase for Y axis
};

/**
 * Compute werewolf cursor position at a given elapsed time.
 * Movement is a noisy circular motion:
 *   base = circular orbit around center (0.5, 0.5) with configurable radius & speed
 *   noise = low-frequency zigzag (sum of two sinusoids with different frequencies)
 *
 * @param elapsed - seconds since demo started
 * @param phase - per-wolf random phase offset (radians)
 * @param noisePhaseX - per-wolf random noise phase for X
 * @param noisePhaseY - per-wolf random noise phase for Y
 * @param speed - revolutions per second (e.g. 0.1 = 10s per revolution)
 * @param noise - noise amplitude in stage coordinates (e.g. 0.08)
 * @param radius - orbit radius in stage coordinates (e.g. 0.25)
 */
function computeWerewolfPosition(
  elapsed: number,
  phase: number,
  noisePhaseX: number,
  noisePhaseY: number,
  speed: number,
  noise: number,
  radius: number,
): { x: number; y: number } {
  const angle = 2 * Math.PI * speed * elapsed + phase;
  const baseX = 0.5 + radius * Math.cos(angle);
  const baseY = 0.5 + radius * Math.sin(angle);

  // Two-frequency noise for organic zigzag (not too fast, broad enough)
  const noiseX = noise * (
    0.6 * Math.sin(1.7 * elapsed + noisePhaseX) +
    0.4 * Math.sin(4.3 * elapsed + noisePhaseX * 1.5)
  );
  const noiseY = noise * (
    0.6 * Math.sin(2.1 * elapsed + noisePhaseY) +
    0.4 * Math.sin(3.7 * elapsed + noisePhaseY * 1.3)
  );

  return {
    x: clamp(baseX + noiseX, 0.02, 0.98),
    y: clamp(baseY + noiseY, 0.02, 0.98),
  };
}

type RandomTargetTrajectory = {
  xAmplitudes: number[];
  xFrequencies: number[];
  xPhases: number[];
  yAmplitudes: number[];
  yFrequencies: number[];
  yPhases: number[];
};

/**
 * Generate a random target trajectory using the sum-of-sinusoids method
 * from Yang, Cowan & Haith (eLife 2021, https://elifesciences.org/articles/62578).
 *
 * The target moves in a 2D trajectory where each axis is a sum of sinusoids:
 *   r(t) = sum_i( a_i * sin(2*pi*f_i*t + phi_i) )
 *
 * Frequencies are prime multiples of 0.05 Hz, with different frequencies for
 * x and y axes so movements at a given frequency can be attributed to one axis.
 * Amplitudes for higher frequencies are proportional to 1/frequency to ensure
 * similar peak velocities. Phases are randomized for each trajectory.
 *
 * Original amplitudes (cm) are scaled to fit within the [0.05, 0.95] stage range.
 */
function generateRandomTargetTrajectory(): RandomTargetTrajectory {
  // Frequencies from the paper (Hz) - prime multiples of 0.05
  const xFrequencies = [0.1, 0.25, 0.55, 0.85, 1.15, 1.55, 2.05];
  const yFrequencies = [0.15, 0.35, 0.65, 0.95, 1.45, 1.85, 2.15];

  // Original amplitudes from the paper (cm)
  const xAmplitudesOrig = [2.31, 2.31, 2.31, 1.76, 1.30, 0.97, 0.73];
  const yAmplitudesOrig = [2.31, 2.31, 2.31, 1.58, 1.03, 0.81, 0.70];

  // Scale factor: the max possible amplitude sum determines the normalization.
  // We want the trajectory to stay within [0.05, 0.95] (i.e., ±0.45 from center 0.5).
  const xMaxSum = xAmplitudesOrig.reduce((a, b) => a + b, 0);
  const yMaxSum = yAmplitudesOrig.reduce((a, b) => a + b, 0);
  const maxSum = Math.max(xMaxSum, yMaxSum);
  const scaleFactor = (0.40 * 0.3) / maxSum; // 0.40 * 0.3 gives slower movement (0.3x speed)

  const xAmplitudes = xAmplitudesOrig.map(a => a * scaleFactor);
  const yAmplitudes = yAmplitudesOrig.map(a => a * scaleFactor);

  // Random phases in [-pi, pi)
  const xPhases = xFrequencies.map(() => Math.random() * 2 * Math.PI - Math.PI);
  const yPhases = yFrequencies.map(() => Math.random() * 2 * Math.PI - Math.PI);

  return { xAmplitudes, xFrequencies, xPhases, yAmplitudes, yFrequencies, yPhases };
}

/**
 * Evaluate the random target position at a given time (seconds from start).
 * Returns {x, y} in [0, 1] stage coordinates.
 */
function evaluateRandomTargetPosition(
  trajectory: RandomTargetTrajectory,
  t: number
): { x: number; y: number } {
  // Ramp factor: linearly increase from 0 to 1 over RANDOM_TARGET_RAMP_S seconds
  const ramp = t < RANDOM_TARGET_RAMP_S ? t / RANDOM_TARGET_RAMP_S : 1.0;

  let xOffset = 0;
  for (let i = 0; i < trajectory.xFrequencies.length; i++) {
    xOffset += trajectory.xAmplitudes[i] * Math.sin(
      2 * Math.PI * trajectory.xFrequencies[i] * t + trajectory.xPhases[i]
    );
  }

  let yOffset = 0;
  for (let i = 0; i < trajectory.yFrequencies.length; i++) {
    yOffset += trajectory.yAmplitudes[i] * Math.sin(
      2 * Math.PI * trajectory.yFrequencies[i] * t + trajectory.yPhases[i]
    );
  }

  return {
    x: clamp(0.5 + ramp * xOffset, 0.02, 0.98),
    y: clamp(0.5 + ramp * yOffset, 0.02, 0.98),
  };
}

function getDefaultTokenServer(): string {
  if (typeof import.meta.env.VITE_TOKEN_SERVER === 'string') {
    return import.meta.env.VITE_TOKEN_SERVER;
  }
  if (typeof window === 'undefined' || !window.location.origin) {
    return 'http://localhost:3001';
  }
  return window.location.origin;
}

const defaultServer = getDefaultTokenServer();

function isLocalOrPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  const match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return false;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 10 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31;
}

function shouldAcceptAgentRecordingCommand(sourceOrigin?: string): boolean {
  if (!sourceOrigin || typeof window === 'undefined') {
    return true;
  }
  if (sourceOrigin === window.location.origin) {
    return true;
  }
  try {
    const source = new URL(sourceOrigin);
    const current = new URL(window.location.origin);
    const sourcePort = source.port || (source.protocol === 'https:' ? '443' : '80');
    const currentPort = current.port || (current.protocol === 'https:' ? '443' : '80');
    return source.protocol === current.protocol
      && sourcePort === currentPort
      && isLocalOrPrivateHostname(source.hostname)
      && isLocalOrPrivateHostname(current.hostname);
  } catch {
    return false;
  }
}

function ensureMediaDevicesEventTargetCompat() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
  const mediaDevices = navigator.mediaDevices as MediaDevices & {
    addEventListener?: EventTarget['addEventListener'];
    removeEventListener?: EventTarget['removeEventListener'];
  };
  if (typeof mediaDevices.addEventListener !== 'function') {
    mediaDevices.addEventListener = () => undefined;
  }
  if (typeof mediaDevices.removeEventListener !== 'function') {
    mediaDevices.removeEventListener = () => undefined;
  }
}

// Default cutoff for the participant latency check (median RTT in ms).
// The actual value is fetched from the server's GET /latency-threshold,
// which mirrors the agent admin's `latencyThresholdMs` config field.
// This default is only used as a fallback if the fetch fails.
const DEFAULT_LATENCY_THRESHOLD_MS = 100;

type RecordingFile = {
  name: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

// Distinct color palette for replay participant cursors
const REPLAY_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9A6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#a9a9a9', '#000000',
];

function ReplayModal({ recording, onClose }: { recording: RecordingRecord; onClose: () => void }) {
  const [frames, setFrames] = useState<FrameSnapshot[]>([]);
  const [loadingFrames, setLoadingFrames] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const animationRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);

  // Track window size for responsive modal (0.8x browser height)
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const modalHeight = windowSize.height * 0.8;
  const modalWidth = Math.max(modalHeight, windowSize.width * 0.7);

  // Fetch frames on mount
  useEffect(() => {
    const fetchFrames = async () => {
      setLoadingFrames(true);
      setLoadError(null);
      try {
        const FRAME_BATCH_SIZE = 1000;
        let allFramesData: { frame_number: number; timestamp: number; cursors: CursorSnapshot[]; average_x: number | null; average_y: number | null; target_x: number | null; target_y: number | null; target_shape: string | null; group_averages?: Record<string, { x: number; y: number }> }[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const { data: frameBatch, error: framesError } = await supabase
            .from('frames')
            .select('*')
            .eq('recording_id', recording.id)
            .order('frame_number', { ascending: true })
            .range(offset, offset + FRAME_BATCH_SIZE - 1);

          if (framesError) {
            setLoadError(`Failed to load frames: ${framesError.message}`);
            return;
          }

          if (frameBatch && frameBatch.length > 0) {
            allFramesData = [...allFramesData, ...frameBatch];
            offset += frameBatch.length;
            hasMore = frameBatch.length === FRAME_BATCH_SIZE;
          } else {
            hasMore = false;
          }
        }

        const parsedFrames: FrameSnapshot[] = allFramesData.map((f) => {
          // group_averages is JSONB with string keys ("0", "1", ...) — convert to numeric keys
          let groupAverages: Record<number, { x: number; y: number }> | undefined;
          if (f.group_averages && Object.keys(f.group_averages).length > 0) {
            groupAverages = {};
            for (const [k, v] of Object.entries(f.group_averages)) {
              groupAverages[Number(k)] = v;
            }
          }
          return {
            frameNumber: f.frame_number,
            timestamp: f.timestamp,
            cursors: f.cursors as CursorSnapshot[],
            average: f.average_x !== null && f.average_y !== null
              ? { x: f.average_x, y: f.average_y }
              : null,
            target: f.target_x !== null && f.target_y !== null && f.target_shape !== null
              ? { x: f.target_x, y: f.target_y, shape: f.target_shape as 'triangle' | 'circle' | 'square' }
              : null,
            ...(groupAverages ? { groupAverages } : {}),
          };
        });
        setFrames(parsedFrames);
      } catch (err) {
        setLoadError(`Failed to load frames: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        setLoadingFrames(false);
      }
    };
    fetchFrames();
  }, [recording.id]);

  // Build participant list with stable color assignment
  const participantMap = useMemo(() => {
    const map = new Map<string, { identity: string; displayName: string; color: string }>();
    let colorIndex = 0;
    for (const frame of frames) {
      for (const cursor of frame.cursors) {
        if (!map.has(cursor.identity)) {
          map.set(cursor.identity, {
            identity: cursor.identity,
            displayName: cursor.displayName || cursor.identity,
            color: REPLAY_COLORS[colorIndex % REPLAY_COLORS.length],
          });
          colorIndex++;
        }
      }
    }
    return map;
  }, [frames]);

  const participants = useMemo(() => Array.from(participantMap.values()), [participantMap]);

  // Compute viewport based on the participant with the largest trajectory range.
  // Scale is determined by the widest-ranging individual participant so the zoom
  // level reflects actual movement amplitude rather than spread across participants.
  const trajectoryBounds = useMemo(() => {
    // Compute per-participant bounding boxes
    const participantBounds = new Map<string, { minX: number; maxX: number; minY: number; maxY: number }>();
    for (const frame of frames) {
      for (const cursor of frame.cursors) {
        const existing = participantBounds.get(cursor.identity);
        if (existing) {
          if (cursor.x < existing.minX) existing.minX = cursor.x;
          if (cursor.x > existing.maxX) existing.maxX = cursor.x;
          if (cursor.y < existing.minY) existing.minY = cursor.y;
          if (cursor.y > existing.maxY) existing.maxY = cursor.y;
        } else {
          participantBounds.set(cursor.identity, {
            minX: cursor.x, maxX: cursor.x,
            minY: cursor.y, maxY: cursor.y,
          });
        }
      }
    }

    // Fallback when no cursor data exists
    if (participantBounds.size === 0) {
      return { minX: 0, maxX: 1, minY: 0, maxY: 1, rangeX: 1, rangeY: 1 };
    }

    // Find the maximum individual trajectory range across all participants
    let maxIndividualRangeX = 0;
    let maxIndividualRangeY = 0;
    for (const bounds of participantBounds.values()) {
      const rangeX = bounds.maxX - bounds.minX;
      const rangeY = bounds.maxY - bounds.minY;
      if (rangeX > maxIndividualRangeX) maxIndividualRangeX = rangeX;
      if (rangeY > maxIndividualRangeY) maxIndividualRangeY = rangeY;
    }

    // Compute the center of all data (union of all participants)
    let allMinX = Infinity, allMaxX = -Infinity;
    let allMinY = Infinity, allMaxY = -Infinity;
    for (const bounds of participantBounds.values()) {
      if (bounds.minX < allMinX) allMinX = bounds.minX;
      if (bounds.maxX > allMaxX) allMaxX = bounds.maxX;
      if (bounds.minY < allMinY) allMinY = bounds.minY;
      if (bounds.maxY > allMaxY) allMaxY = bounds.maxY;
    }
    const centerX = (allMinX + allMaxX) / 2;
    const centerY = (allMinY + allMaxY) / 2;

    // Use the max individual participant range as the viewport scale,
    // centered on the overall data center.
    // Fallback to a minimum range of 0.1 to avoid division-by-zero when
    // participants never move (zero range).
    const margin = 0.02;
    const rangeX = Math.max(maxIndividualRangeX, 0.1);
    const rangeY = Math.max(maxIndividualRangeY, 0.1);
    return {
      minX: centerX - rangeX * (0.5 + margin),
      maxX: centerX + rangeX * (0.5 + margin),
      minY: centerY - rangeY * (0.5 + margin),
      maxY: centerY + rangeY * (0.5 + margin),
      rangeX: rangeX * (1 + 2 * margin),
      rangeY: rangeY * (1 + 2 * margin),
    };
  }, [frames]);

  // Animation loop
  useEffect(() => {
    if (!isPlaying || frames.length === 0) return;

    const frameInterval = (1000 / recording.frame_rate) / playbackSpeed;

    const animate = (timestamp: number) => {
      if (timestamp - lastFrameTimeRef.current >= frameInterval) {
        lastFrameTimeRef.current = timestamp;
        setCurrentFrameIndex((prev) => {
          if (prev >= frames.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }
      animationRef.current = requestAnimationFrame(animate);
    };

    lastFrameTimeRef.current = performance.now();
    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isPlaying, frames.length, playbackSpeed, recording.frame_rate]);

  const togglePlayPause = () => {
    if (currentFrameIndex >= frames.length - 1) {
      setCurrentFrameIndex(0);
    }
    setIsPlaying((prev) => !prev);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    setCurrentFrameIndex(value);
    setIsPlaying(false);
  };

  const currentFrame = frames[currentFrameIndex] || null;

  const elapsedSeconds = currentFrame && frames[0]
    ? ((currentFrame.timestamp - frames[0].timestamp) / 1000).toFixed(1)
    : '0.0';
  const totalSeconds = frames.length > 1
    ? ((frames[frames.length - 1].timestamp - frames[0].timestamp) / 1000).toFixed(1)
    : '0.0';

  // Compute stage size to fit within the modal, accounting for header (~50px), controls (~50px), legend (~80px), padding (48px)
  // Use aspect ratio from trajectory bounds to properly scale the stage
  const boundsAspect = trajectoryBounds.rangeX / trajectoryBounds.rangeY;
  const maxStageWidth = modalWidth - 48;
  const maxStageHeight = modalHeight - 228;
  let STAGE_WIDTH: number;
  let STAGE_HEIGHT: number;
  if (boundsAspect >= 1) {
    // Wider than tall
    STAGE_WIDTH = Math.max(200, Math.min(maxStageWidth, maxStageHeight * boundsAspect));
    STAGE_HEIGHT = STAGE_WIDTH / boundsAspect;
  } else {
    // Taller than wide
    STAGE_HEIGHT = Math.max(200, Math.min(maxStageHeight, maxStageWidth / boundsAspect));
    STAGE_WIDTH = STAGE_HEIGHT * boundsAspect;
  }
  // Clamp to available space
  if (STAGE_WIDTH > maxStageWidth) {
    STAGE_WIDTH = maxStageWidth;
    STAGE_HEIGHT = STAGE_WIDTH / boundsAspect;
  }
  if (STAGE_HEIGHT > maxStageHeight) {
    STAGE_HEIGHT = maxStageHeight;
    STAGE_WIDTH = STAGE_HEIGHT * boundsAspect;
  }

  return (
    <div className="replay-modal-overlay" onClick={onClose}>
      <div className="replay-modal-content" style={{ width: modalWidth, height: modalHeight }} onClick={(e) => e.stopPropagation()}>
        <div className="replay-modal-header">
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>
            Replay: {recording.experiment_name || '(unnamed)'} — Trial #{recording.trial_number}
          </h2>
          <button className="replay-close-button" onClick={onClose}>✕</button>
        </div>

        {loadingFrames ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#6b7280' }}>Loading frames...</div>
        ) : loadError ? (
          <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.5rem', color: '#dc2626' }}>{loadError}</div>
        ) : frames.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#6b7280' }}>No frames found for this recording.</div>
        ) : (
          <>
            {/* Stage area — replay reuses <TaskStage> with a custom viewport
                (the recorded trajectory bounds) and the dashed [0,1]
                reference box turned on. No taskMode is passed because
                replay is task-agnostic; the framework's generic fallback
                renders the recorded target shape directly. */}
            <div className="replay-stage-wrapper">
              <div className="replay-stage" style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT, position: 'relative' }}>
                <TaskStage
                  background="white"
                  showBoundaryBox
                  viewport={{
                    minX: trajectoryBounds.minX,
                    minY: trajectoryBounds.minY,
                    rangeX: trajectoryBounds.rangeX,
                    rangeY: trajectoryBounds.rangeY,
                  }}
                  cursors={currentFrame
                    ? currentFrame.cursors.map((c) => ({
                        id: c.identity,
                        x: c.x,
                        y: c.y,
                        diameter: 14,
                        fill: participantMap.get(c.identity)?.color || '#999',
                        opacity: 0.5,
                      }))
                    : []}
                  averages={(() => {
                    if (!currentFrame) return [];
                    const ga = currentFrame.groupAverages;
                    if (ga && Object.keys(ga).length > 0) {
                      return Object.entries(ga).map(([gid, pos]) => ({
                        id: `group-avg-${gid}`,
                        x: pos.x,
                        y: pos.y,
                        diameter: 20,
                        fill: colorForGroup(Number(gid)),
                        stroke: '#ffffff',
                        strokeWidth: 2,
                      }));
                    }
                    if (currentFrame.average) {
                      return [{
                        id: 'avg',
                        x: currentFrame.average.x,
                        y: currentFrame.average.y,
                        diameter: 20,
                        fill: '#2563eb',
                        stroke: '#ffffff',
                        strokeWidth: 2,
                      }];
                    }
                    return [];
                  })()}
                  target={currentFrame?.target
                    ? {
                        x: currentFrame.target.x,
                        y: currentFrame.target.y,
                        shape: currentFrame.target.shape,
                        size: currentFrame.target.shape === 'triangle' ? 20 : 16,
                        fill: '#dc2626',
                      }
                    : null}
                />
              </div>
            </div>

            {/* Playback controls */}
            <div className="replay-controls">
              <button className="replay-play-button" onClick={togglePlayPause}>
                {isPlaying ? '⏸' : '▶'}
              </button>

              <input
                type="range"
                className="replay-seek-bar"
                min={0}
                max={frames.length - 1}
                value={currentFrameIndex}
                onChange={handleSeek}
              />

              <span className="replay-time">{elapsedSeconds}s / {totalSeconds}s</span>

              <div className="replay-speed-controls">
                {[0.25, 0.5, 1, 2, 4].map((speed) => (
                  <button
                    key={speed}
                    className={`replay-speed-button ${playbackSpeed === speed ? 'active' : ''}`}
                    onClick={() => setPlaybackSpeed(speed)}
                  >
                    {speed}x
                  </button>
                ))}
              </div>
            </div>

            {/* Participant color legend */}
            <div className="replay-legend">
              <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', fontWeight: '600', color: '#374151' }}>Participants</h3>
              <div className="replay-legend-grid">
                {participants.map((p) => {
                  const gid = recording.group_assignments?.[p.identity];
                  return (
                    <div key={p.identity} className="replay-legend-item">
                      <span className="replay-legend-color" style={{ backgroundColor: p.color }} />
                      <span className="replay-legend-name" title={p.identity}>
                        {p.displayName}
                        {gid !== undefined && (
                          <span style={{ marginLeft: '4px', fontSize: '10px', color: colorForGroup(gid), fontWeight: 'bold' }}>
                            [G{gid}]
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
                {recording.group_count && recording.group_count > 1 ? (
                  Array.from({ length: recording.group_count }, (_, i) => (
                    <div key={`group-${i}`} className="replay-legend-item">
                      <span className="replay-legend-color" style={{ backgroundColor: colorForGroup(i) }} />
                      <span className="replay-legend-name">Group {i} Average</span>
                    </div>
                  ))
                ) : (
                  <div className="replay-legend-item">
                    <span className="replay-legend-color replay-legend-color-average" />
                    <span className="replay-legend-name">Average Cursor</span>
                  </div>
                )}
                <div className="replay-legend-item">
                  <span className="replay-legend-color" style={{ backgroundColor: '#dc2626' }} />
                  <span className="replay-legend-name">Target</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Fetch every frame/event/broadcast row for a single recording and assemble a RecordingSession.
 *  Used by both per-trial download and the bulk session-level download. */
async function fetchRecordingSession(recording: RecordingRecord): Promise<RecordingSession> {
  const { data: jsonRow, error: jsonError } = await supabase
    .from('recordings')
    .select('session_json')
    .eq('id', recording.id)
    .maybeSingle();

  if (jsonError && !isMissingDatabaseColumnError(jsonError)) {
    throw new Error(`Failed to fetch recording JSON: ${jsonError.message}`);
  }
  if (jsonRow?.session_json && Object.keys(jsonRow.session_json).length > 0) {
    return jsonRow.session_json as RecordingSession;
  }

  const FRAME_BATCH_SIZE = 1000;
  let allFramesData: { frame_number: number; timestamp: number; cursors: CursorSnapshot[]; average_x: number | null; average_y: number | null; target_x: number | null; target_y: number | null; target_shape: string | null; participant_targets?: FrameSnapshot['participantTargets']; group_averages?: Record<string, { x: number; y: number }> }[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: frameBatch, error: framesError } = await supabase
      .from('frames')
      .select('*')
      .eq('recording_id', recording.id)
      .order('frame_number', { ascending: true })
      .range(offset, offset + FRAME_BATCH_SIZE - 1);

    if (framesError) {
      throw new Error(`Failed to fetch frames: ${framesError.message}`);
    }

    if (frameBatch && frameBatch.length > 0) {
      allFramesData = [...allFramesData, ...frameBatch];
      offset += frameBatch.length;
      hasMore = frameBatch.length === FRAME_BATCH_SIZE;
    } else {
      hasMore = false;
    }
  }

  const [eventsResult, messagesResult] = await Promise.all([
    supabase
      .from('events')
      .select('*')
      .eq('recording_id', recording.id)
      .order('timestamp', { ascending: true }),
    supabase
      .from('broadcast_messages')
      .select('*')
      .eq('recording_id', recording.id)
      .order('timestamp', { ascending: true }),
  ]);

  if (eventsResult.error) throw new Error(`Failed to fetch events: ${eventsResult.error.message}`);
  if (messagesResult.error) throw new Error(`Failed to fetch messages: ${messagesResult.error.message}`);

  const savedSessionEvent = (eventsResult.data || []).find((event: { event_type: string; event_data: Record<string, unknown> }) => (
    event.event_type === 'recordingSessionJson'
    && event.event_data
    && typeof event.event_data === 'object'
    && 'session' in event.event_data
  ));
  if (savedSessionEvent) {
    return (savedSessionEvent.event_data as { session: RecordingSession }).session;
  }

  const frames: FrameSnapshot[] = allFramesData.map((f) => {
    let groupAverages: Record<number, { x: number; y: number }> | undefined;
    if (f.group_averages && Object.keys(f.group_averages).length > 0) {
      groupAverages = {};
      for (const [k, v] of Object.entries(f.group_averages)) {
        groupAverages[Number(k)] = v;
      }
    }
    return {
      frameNumber: f.frame_number,
      timestamp: f.timestamp,
      cursors: f.cursors as CursorSnapshot[],
      average: f.average_x !== null && f.average_y !== null
        ? { x: f.average_x, y: f.average_y }
        : null,
      target: f.target_x !== null && f.target_y !== null && f.target_shape !== null
        ? { x: f.target_x, y: f.target_y, shape: f.target_shape as 'triangle' | 'circle' | 'square' }
        : null,
      ...(f.participant_targets ? { participantTargets: f.participant_targets } : {}),
      ...(groupAverages ? { groupAverages } : {}),
    };
  });

  const events: AdminEventExport[] = (eventsResult.data || []).map((e: { event_type: string; event_data: Record<string, unknown>; timestamp: number; relative_time: number }) => ({
    type: e.event_type,
    ...e.event_data,
    timestamp: e.timestamp,
    t: e.relative_time,
  } as AdminEventExport));

  const broadcastMessages = (messagesResult.data || []).map((m: { message_id: string; text: string; duration_ms: number | null; severity: string | null; position: string | null; timestamp: number }) => ({
    id: m.message_id,
    type: 'broadcast' as const,
    text: m.text,
    durationMs: m.duration_ms ?? undefined,
    severity: (m.severity as 'info' | 'warning' | 'error') ?? undefined,
    position: (m.position as 'center' | 'bottom') ?? undefined,
    timestamp: m.timestamp,
  }));

  return {
    startTime: recording.start_time,
    endTime: recording.end_time ?? undefined,
    roomName: recording.room_name,
    frames,
    frameRate: recording.frame_rate,
    broadcastMessages,
    events,
    experimentName: recording.experiment_name,
    trialNumber: recording.trial_number,
    taskType: recording.task_type ?? '',
    displayMode: (recording.display_mode ?? 'avgOnly') as DisplayMode,
    participantCount: recording.participant_count ?? 0,
    experimentConfig: recording.experiment_config ?? undefined,
    trialMetadata: recording.trial_metadata ?? undefined,
    ...(recording.group_count && recording.group_count > 1 && recording.group_assignments
      ? { groupAssignments: { assignments: recording.group_assignments, groupCount: recording.group_count } }
      : {}),
  };
}

function interpolateDisturbanceParam(
  start: CursorControlDisturbanceParams | undefined,
  end: CursorControlDisturbanceParams | undefined,
  alpha: number,
): CursorControlDisturbanceParams {
  const s = start ?? { gainA: 1, gainB: 1, rotationDeg: 0 };
  const e = end ?? s;
  const lerp = (a: number, b: number) => a + (b - a) * alpha;
  return {
    gainA: lerp(Number.isFinite(s.gainA) ? s.gainA : 1, Number.isFinite(e.gainA) ? e.gainA : 1),
    gainB: lerp(Number.isFinite(s.gainB) ? s.gainB : 1, Number.isFinite(e.gainB) ? e.gainB : 1),
    rotationDeg: lerp(Number.isFinite(s.rotationDeg) ? s.rotationDeg : 0, Number.isFinite(e.rotationDeg) ? e.rotationDeg : 0),
  };
}

function disturbanceAlpha(disturbance: CursorControlDisturbance | null, startedAt: number | null): number {
  if (!disturbance?.enabled || startedAt === null) return 0;
  const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
  const rampStart = Math.max(0, disturbance.rampStartSeconds ?? 0);
  const rampDuration = Math.max(0, disturbance.rampDurationSeconds ?? 0);
  if (elapsedSeconds <= rampStart) return 0;
  if (rampDuration <= 0) return 1;
  return Math.min(1, Math.max(0, (elapsedSeconds - rampStart) / rampDuration));
}

function applyCursorControlDisturbance(
  cursor: { x: number; y: number },
  params: CursorControlDisturbanceParams,
  type?: string,
): { x: number; y: number } {
  const dx = cursor.x - 0.5;
  const dy = cursor.y - 0.5;
  let gainX: number;
  let gainY: number;
  if (type === 'axis-aligned-gain-plus-rotation') {
    gainX = (params.gainA ?? 1) * dx;
    gainY = (params.gainB ?? 1) * dy;
  } else {
    const invSqrt2 = Math.SQRT1_2;
    const alongPosDiag = (dx + dy) * invSqrt2;
    const alongNegDiag = (dx - dy) * invSqrt2;
    gainX = ((params.gainA ?? 1) * alongPosDiag + (params.gainB ?? 1) * alongNegDiag) * invSqrt2;
    gainY = ((params.gainA ?? 1) * alongPosDiag - (params.gainB ?? 1) * alongNegDiag) * invSqrt2;
  }
  const theta = ((params.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: 0.5 + cos * gainX - sin * gainY,
    y: 0.5 + sin * gainX + cos * gainY,
  };
}

/** Sanitize a filename component so the bulk-download filename stays valid across OSes. */
function sanitizeFilenamePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'session';
}

/** A logical session = all trials that share `experiment_name`. */
type SessionGroup = {
  key: string;
  experimentName: string;
  taskType: string;
  participantCount: number;
  groupCount: number;
  startTime: number;
  recordings: RecordingRecord[];
};

/** A logical date = all sessions that ran on a single calendar day (local time). */
type DateGroup = {
  key: string;
  startOfDay: number;
  sessions: SessionGroup[];
  totalRecordings: number;
};

function dateKeyOf(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateHeader(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
  return `${dateKey} (${weekday})`;
}

function formatTimeOnly(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Build a 2-level tree: date (desc by day) → session (desc by start) → trials (asc by trial #).
 *  Session key is `experiment_name` when present; older rows without it become singleton sessions
 *  keyed by `__solo__:${id}` so they still appear under the correct date. */
function groupRecordings(recordings: RecordingRecord[]): DateGroup[] {
  const byDate = new Map<string, Map<string, RecordingRecord[]>>();
  for (const rec of recordings) {
    const dKey = dateKeyOf(rec.start_time);
    const sKey = rec.experiment_name && rec.experiment_name.length > 0
      ? rec.experiment_name
      : `__solo__:${rec.id}`;
    let sessions = byDate.get(dKey);
    if (!sessions) {
      sessions = new Map();
      byDate.set(dKey, sessions);
    }
    const list = sessions.get(sKey);
    if (list) list.push(rec); else sessions.set(sKey, [rec]);
  }

  const dateGroups: DateGroup[] = [];
  for (const [dKey, sessionsMap] of byDate.entries()) {
    const sessionGroups: SessionGroup[] = [];
    for (const [sKey, recs] of sessionsMap.entries()) {
      // Trials within a session: ascending by trial_number (chronological)
      recs.sort((a, b) => a.trial_number - b.trial_number || a.start_time - b.start_time);
      const first = recs[0];
      sessionGroups.push({
        key: sKey,
        experimentName: first.experiment_name || '(unnamed)',
        taskType: first.task_type ?? '',
        participantCount: first.participant_count ?? 0,
        groupCount: first.group_count ?? 1,
        startTime: Math.min(...recs.map((r) => r.start_time)),
        recordings: recs,
      });
    }
    // Sessions within a day: most recent first
    sessionGroups.sort((a, b) => b.startTime - a.startTime);
    const [y, m, d] = dKey.split('-').map(Number);
    dateGroups.push({
      key: dKey,
      startOfDay: new Date(y, m - 1, d).getTime(),
      sessions: sessionGroups,
      totalRecordings: sessionGroups.reduce((acc, s) => acc + s.recordings.length, 0),
    });
  }
  // Days: most recent first
  dateGroups.sort((a, b) => b.startOfDay - a.startOfDay);
  return dateGroups;
}

function formatSessionMeta(s: SessionGroup): string {
  const parts: string[] = [];
  parts.push(s.taskType || 'unknown-task');
  parts.push(`${s.participantCount} participant${s.participantCount === 1 ? '' : 's'}`);
  if (s.groupCount > 1) parts.push(`${s.groupCount} groups`);
  parts.push(`started ${formatTimeOnly(s.startTime)}`);
  return parts.join(' · ');
}

function triggerJsonDownload(filename: string, body: unknown): void {
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function DatabaseAdmin({ embedded = false, refreshKey = 0 }: { embedded?: boolean; refreshKey?: number }) {
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [replayRecording, setReplayRecording] = useState<RecordingRecord | null>(null);
  // Bulk session download progress: { key, current, total } while a session bundle is being assembled
  const [bulkProgress, setBulkProgress] = useState<{ key: string; current: number; total: number } | null>(null);

  useEffect(() => {
    loadRecordings();
  }, [refreshKey]);

  const loadRecordings = async () => {
    setLoading(true);
    setError(null);
      console.log('[DatabaseAdmin] Loading recordings from Supabase tables...');
    try {
      let { data, error: listError } = await supabase
        .from('recordings')
        .select(RECORDINGS_LIST_SELECT)
        .order('created_at', { ascending: false });

      if (listError && isMissingDatabaseColumnError(listError)) {
        console.warn('[DatabaseAdmin] Falling back to legacy recordings query:', listError.message);
        const fallback = await supabase
          .from('recordings')
          .select('*')
          .order('created_at', { ascending: false });
        data = fallback.data;
        listError = fallback.error;
      }

      console.log('[DatabaseAdmin] Query response - data:', data, 'error:', listError);

      if (listError) {
        console.error('[DatabaseAdmin] Query error:', listError);
        setError(`Failed to load recordings: ${listError.message}`);
        return;
      }

      setRecordings((data ?? []) as unknown as RecordingRecord[]);
    } catch (err) {
      console.error('[DatabaseAdmin] Exception:', err);
      setError(`Failed to load recordings: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const downloadRecording = async (recording: RecordingRecord) => {
    setDownloadingId(recording.id);
    setError(null);
    try {
      console.log('[DatabaseAdmin] Downloading recording:', recording.id);
      const session = await fetchRecordingSession(recording);
      triggerJsonDownload(buildRecordingFilename({
        startTime: recording.start_time,
        taskType: recording.task_type,
        participantCount: recording.participant_count,
        trialNumber: recording.trial_number,
        displayMode: recording.display_mode,
      }), session);
    } catch (err) {
      setError(`Failed to download: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const downloadSession = async (session: SessionGroup) => {
    setBulkProgress({ key: session.key, current: 0, total: session.recordings.length });
    setError(null);
    try {
      console.log(`[DatabaseAdmin] Bulk-downloading session "${session.experimentName}" (${session.recordings.length} trials)`);
      const trials: RecordingSession[] = [];
      for (let i = 0; i < session.recordings.length; i += 1) {
        const rec = session.recordings[i];
        trials.push(await fetchRecordingSession(rec));
        setBulkProgress({ key: session.key, current: i + 1, total: session.recordings.length });
      }
      const endTime = trials.reduce((max, t) => Math.max(max, t.endTime ?? t.startTime), 0);
      const bundle = {
        experimentName: session.experimentName,
        taskType: session.taskType,
        participantCount: session.participantCount,
        groupCount: session.groupCount,
        startTime: session.startTime,
        endTime: endTime || undefined,
        trialCount: trials.length,
        trials,
      };
      const namePart = sanitizeFilenamePart(session.experimentName);
      const ts = formatTimestampForFilename(session.startTime);
      triggerJsonDownload(`${ts}_${namePart}_${trials.length}-trials.json`, bundle);
    } catch (err) {
      setError(`Failed to download session: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setBulkProgress(null);
    }
  };

  const deleteRecording = async (recording: RecordingRecord) => {
    if (!confirm(`Are you sure you want to delete this recording?\n\nExperiment: ${recording.experiment_name || '(unnamed)'}\nTrial: ${recording.trial_number}\n\nThis action cannot be undone.`)) {
      return;
    }

    setDeletingId(recording.id);
    setError(null);
    try {
      const { error: deleteError } = await supabase
        .from('recordings')
        .delete()
        .eq('id', recording.id);

      if (deleteError) {
        setError(`Failed to delete: ${deleteError.message}`);
        return;
      }

      setRecordings(prev => prev.filter(r => r.id !== recording.id));
    } catch (err) {
      setError(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeletingId(null);
    }
  };

  const formatDuration = (startTime: number, endTime: number | null): string => {
    if (!endTime) return 'In progress';
    const durationMs = endTime - startTime;
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const dateGroups = useMemo(() => groupRecordings(recordings), [recordings]);

  return (
    <div style={{
      padding: embedded ? '1rem' : '2rem',
      maxWidth: '1400px',
      margin: embedded ? '1rem' : '0 auto',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      background: embedded ? '#ffffff' : undefined,
      border: embedded ? '1px solid #dbe3ee' : undefined,
      borderRadius: embedded ? '0.75rem' : undefined,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: embedded ? '1.15rem' : '1.5rem', fontWeight: '600', color: '#111827' }}>Recording Database</h1>
          <div style={{ marginTop: '0.35rem', fontSize: '0.78rem', color: '#475569' }}>
            <strong>{RECORDING_STORAGE.label}</strong> · {RECORDING_STORAGE.url}
          </div>
          <div style={{ marginTop: '0.15rem', fontSize: '0.72rem', color: '#64748b' }}>
            {RECORDING_STORAGE.detail}
          </div>
        </div>
        <button
          onClick={loadRecordings}
          disabled={loading}
          style={{
            padding: '0.5rem 1rem',
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: '0.375rem',
            fontWeight: '500',
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '0.5rem', color: '#dc2626', marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#6b7280' }}>Loading recordings...</div>
      ) : recordings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#6b7280', background: '#f9fafb', borderRadius: '0.5rem' }}>
          No recordings found. Start recording from the admin panel to see data here.
        </div>
      ) : (
        <div className="db-accordion" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {dateGroups.map((dateGroup) => (
            <details
              key={dateGroup.key}
              open
              style={{
                background: 'white',
                borderRadius: '0.5rem',
                border: '1px solid #e5e7eb',
                overflow: 'hidden',
              }}
            >
              <summary
                style={{
                  padding: '0.875rem 1rem',
                  cursor: 'pointer',
                  fontSize: '0.95rem',
                  fontWeight: 600,
                  color: '#111827',
                  background: '#f3f4f6',
                  borderBottom: '1px solid #e5e7eb',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span className="db-summary-left" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <span className="db-chevron">▶</span>
                  <span>{formatDateHeader(dateGroup.key)}</span>
                </span>
                <span style={{ fontSize: '0.8rem', fontWeight: 500, color: '#6b7280' }}>
                  {dateGroup.sessions.length} session{dateGroup.sessions.length === 1 ? '' : 's'} ·{' '}
                  {dateGroup.totalRecordings} recording{dateGroup.totalRecordings === 1 ? '' : 's'}
                </span>
              </summary>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem' }}>
                {dateGroup.sessions.map((session) => {
                  const isBulkActive = bulkProgress?.key === session.key;
                  return (
                    <details
                      key={session.key}
                      style={{
                        background: '#fafafa',
                        border: '1px solid #e5e7eb',
                        borderRadius: '0.375rem',
                        overflow: 'hidden',
                      }}
                    >
                      <summary
                        style={{
                          padding: '0.625rem 0.875rem',
                          cursor: 'pointer',
                          fontSize: '0.875rem',
                          color: '#1f2937',
                          background: '#f9fafb',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '1rem',
                        }}
                      >
                        <div className="db-summary-left" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', minWidth: 0 }}>
                          <span className="db-chevron">▶</span>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0 }}>
                            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {session.experimentName}
                            </span>
                            <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                              {formatSessionMeta(session)} · {session.recordings.length} trial{session.recordings.length === 1 ? '' : 's'}
                            </span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (!isBulkActive) downloadSession(session);
                            }}
                            disabled={isBulkActive}
                            style={{
                              padding: '0.375rem 0.75rem',
                              background: '#0ea5e9',
                              color: 'white',
                              border: 'none',
                              borderRadius: '0.25rem',
                              fontSize: '0.75rem',
                              fontWeight: 500,
                              cursor: isBulkActive ? 'not-allowed' : 'pointer',
                              opacity: isBulkActive ? 0.7 : 1,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {isBulkActive
                              ? `Downloading ${bulkProgress!.current}/${bulkProgress!.total}...`
                              : `JSON (${session.recordings.length} trials)`}
                          </button>
                        </div>
                      </summary>

                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: '#ffffff', borderBottom: '1px solid #e5e7eb' }}>
                              <th style={{ padding: '0.5rem 0.875rem', textAlign: 'left', fontSize: '0.7rem', fontWeight: 600, color: '#374151', textTransform: 'uppercase' }}>Trial</th>
                              <th style={{ padding: '0.5rem 0.875rem', textAlign: 'left', fontSize: '0.7rem', fontWeight: 600, color: '#374151', textTransform: 'uppercase' }}>Room</th>
                              <th style={{ padding: '0.5rem 0.875rem', textAlign: 'left', fontSize: '0.7rem', fontWeight: 600, color: '#374151', textTransform: 'uppercase' }}>Started</th>
                              <th style={{ padding: '0.5rem 0.875rem', textAlign: 'left', fontSize: '0.7rem', fontWeight: 600, color: '#374151', textTransform: 'uppercase' }}>Duration</th>
                              <th style={{ padding: '0.5rem 0.875rem', textAlign: 'left', fontSize: '0.7rem', fontWeight: 600, color: '#374151', textTransform: 'uppercase' }}>Frames</th>
                              <th style={{ padding: '0.5rem 0.875rem', textAlign: 'right', fontSize: '0.7rem', fontWeight: 600, color: '#374151', textTransform: 'uppercase' }}>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {session.recordings.map((recording, index) => (
                              <tr
                                key={recording.id}
                                style={{
                                  borderBottom: index < session.recordings.length - 1 ? '1px solid #e5e7eb' : 'none',
                                  background: '#ffffff',
                                }}
                              >
                                <td style={{ padding: '0.5rem 0.875rem', fontSize: '0.875rem', color: '#2563eb', fontWeight: 600 }}>
                                  #{recording.trial_number}
                                </td>
                                <td style={{ padding: '0.5rem 0.875rem', fontSize: '0.8rem', color: '#6b7280' }}>{recording.room_name}</td>
                                <td style={{ padding: '0.5rem 0.875rem', fontSize: '0.8rem', color: '#6b7280' }}>{formatTimeOnly(recording.start_time)}</td>
                                <td style={{ padding: '0.5rem 0.875rem', fontSize: '0.8rem', color: '#6b7280' }}>
                                  {formatDuration(recording.start_time, recording.end_time)}
                                </td>
                                <td style={{ padding: '0.5rem 0.875rem', fontSize: '0.8rem', color: '#6b7280' }}>
                                  {recording.total_frames.toLocaleString()}
                                </td>
                                <td style={{ padding: '0.5rem 0.875rem', textAlign: 'right' }}>
                                  <button
                                    onClick={() => setReplayRecording(recording)}
                                    style={{
                                      padding: '0.375rem 0.75rem',
                                      background: '#6366f1',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: '0.25rem',
                                      fontSize: '0.75rem',
                                      fontWeight: 500,
                                      cursor: 'pointer',
                                      marginRight: '0.5rem',
                                    }}
                                  >
                                    Replay
                                  </button>
                                  <button
                                    onClick={() => downloadRecording(recording)}
                                    disabled={downloadingId === recording.id}
                                    style={{
                                      padding: '0.375rem 0.75rem',
                                      background: '#10b981',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: '0.25rem',
                                      fontSize: '0.75rem',
                                      fontWeight: 500,
                                      cursor: downloadingId === recording.id ? 'not-allowed' : 'pointer',
                                      opacity: downloadingId === recording.id ? 0.7 : 1,
                                      marginRight: '0.5rem',
                                    }}
                                  >
                                    {downloadingId === recording.id ? 'Downloading...' : 'JSON'}
                                  </button>
                                  <button
                                    onClick={() => deleteRecording(recording)}
                                    disabled={deletingId === recording.id}
                                    style={{
                                      padding: '0.375rem 0.75rem',
                                      background: '#ef4444',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: '0.25rem',
                                      fontSize: '0.75rem',
                                      fontWeight: 500,
                                      cursor: deletingId === recording.id ? 'not-allowed' : 'pointer',
                                      opacity: deletingId === recording.id ? 0.7 : 1,
                                    }}
                                  >
                                    {deletingId === recording.id ? 'Deleting...' : 'Delete'}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}

      {!embedded && (
        <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
          <a href="/" style={{ color: '#2563eb', textDecoration: 'none', fontSize: '0.875rem' }}>
            Back to Main App
          </a>
        </div>
      )}

      {replayRecording && (
        <ReplayModal recording={replayRecording} onClose={() => setReplayRecording(null)} />
      )}
    </div>
  );
}

async function getRttMs(room: Room | null): Promise<number | null> {
  // Returns the RTT of each transport's actively SELECTED ICE candidate pair,
  // taking MAX across publisher + subscriber so the worst path drives the
  // result (both paths must be acceptable for the participant to have a good
  // experiment experience).
  //
  // Important: `getStats()` returns *every* candidate-pair that ever reached
  // the 'succeeded' state during ICE — including pairs that were checked but
  // never selected to carry traffic. Non-selected pairs keep their
  // `currentRoundTripTime` *frozen* at the value from their initial
  // connectivity check (no further STUN runs on them), which can be
  // misleadingly low. A previous implementation took the min across all
  // succeeded pairs, which let high-latency participants pass the gate when
  // one of those stale connectivity-check values happened to be lower than
  // the real selected-pair RTT. We now read only the selected pair.
  if (!room) return null;

  try {
    const engine = (room as any).engine;
    if (!engine || !engine.pcManager) return null;

    const pcManager = engine.pcManager;
    const transports: unknown[] = [];
    if (pcManager.publisher) transports.push(pcManager.publisher);
    if (pcManager.subscriber) transports.push(pcManager.subscriber);
    if (transports.length === 0) return null;

    let maxRttMs: number | null = null;

    for (const transport of transports) {
      try {
        const stats = await (transport as { getStats: () => Promise<RTCStatsReport> }).getStats();

        // Step 1: find the SELECTED candidate-pair ID from the transport
        //         stats report (the canonical cross-browser way).
        let selectedPairId: string | undefined;
        for (const report of stats.values()) {
          if (report.type === 'transport') {
            const id = (report as { selectedCandidatePairId?: string }).selectedCandidatePairId;
            if (typeof id === 'string' && id.length > 0) {
              selectedPairId = id;
              break;
            }
          }
        }

        // Step 2: read RTT only from the selected pair. Fall back to a
        //         `nominated && succeeded` pair if the transport stats report
        //         didn't expose the selection (older Safari behavior). NEVER
        //         fall back to "any succeeded pair" — that's exactly the path
        //         that caused the gate to leak.
        let pairRttMs: number | null = null;
        if (selectedPairId !== undefined) {
          for (const report of stats.values()) {
            if (report.type === 'candidate-pair' && report.id === selectedPairId) {
              const rtt = (report as { currentRoundTripTime?: number }).currentRoundTripTime;
              if (typeof rtt === 'number' && rtt > 0) {
                pairRttMs = Math.round(rtt * 1000);
              }
              break;
            }
          }
        }
        if (pairRttMs === null) {
          for (const report of stats.values()) {
            if (
              report.type === 'candidate-pair' &&
              (report as { state?: string }).state === 'succeeded' &&
              (report as { nominated?: boolean }).nominated === true
            ) {
              const rtt = (report as { currentRoundTripTime?: number }).currentRoundTripTime;
              if (typeof rtt === 'number' && rtt > 0) {
                pairRttMs = Math.round(rtt * 1000);
                break;
              }
            }
          }
        }

        if (pairRttMs !== null) {
          // MAX across transports: the worst path is what matters for the gate.
          if (maxRttMs === null || pairRttMs > maxRttMs) {
            maxRttMs = pairRttMs;
          }
        }
      } catch (err) {
        console.warn('Failed to get stats from transport', err);
      }
    }

    return maxRttMs;
  } catch (err) {
    console.warn('Failed to get RTT', err);
    return null;
  }
}

function MobileController({ onJoystickMove, connectionState, joystickMultiplier }: { onJoystickMove: (dx: number, dy: number) => void; connectionState: ConnectionState; joystickMultiplier: number }) {
  const joystickRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [knobPosition, setKnobPosition] = useState({ x: 0, y: 0 });
  const velocityRef = useRef({ x: 0, y: 0 });
  const animationFrameRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef(0);

  const handleStart = useCallback((clientX: number, clientY: number) => {
    setIsDragging(true);
  }, []);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!isDragging || !joystickRef.current) return;
    
    const rect = joystickRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const maxRadius = rect.width / 2 - 30;
    
    let deltaX = clientX - centerX;
    let deltaY = clientY - centerY;
    
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (distance > maxRadius) {
      deltaX = (deltaX / distance) * maxRadius;
      deltaY = (deltaY / distance) * maxRadius;
    }
    
    setKnobPosition({ x: deltaX, y: deltaY });
    
    // Convert joystick position to velocity (-1 to 1 range)
    velocityRef.current = {
      x: deltaX / maxRadius,
      y: deltaY / maxRadius,
    };
  }, [isDragging]);

  const handleEnd = useCallback(() => {
    setIsDragging(false);
    setKnobPosition({ x: 0, y: 0 });
    velocityRef.current = { x: 0, y: 0 };
  }, []);

  useEffect(() => {
    const handleTouchMove = (e: TouchEvent) => {
      if (isDragging && e.touches.length > 0) {
        e.preventDefault();
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    
    const handleTouchEnd = () => {
      if (isDragging) {
        handleEnd();
      }
    };
    
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        handleMove(e.clientX, e.clientY);
      }
    };
    
    const handleMouseUp = () => {
      if (isDragging) {
        handleEnd();
      }
    };

    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMove, handleEnd]);

  // Velocity-based cursor movement loop
  useEffect(() => {
    if (connectionState !== 'connected') {
      return;
    }

    const updateLoop = () => {
      const now = performance.now();
      const deltaTime = lastUpdateTimeRef.current > 0 ? (now - lastUpdateTimeRef.current) / 1000 : 0;
      lastUpdateTimeRef.current = now;

      const velocity = velocityRef.current;
      if (velocity.x !== 0 || velocity.y !== 0) {
        // Apply velocity with multiplier (base speed is 0.5 units per second at full deflection)
        const dx = velocity.x * joystickMultiplier * 0.5 * deltaTime;
        const dy = velocity.y * joystickMultiplier * 0.5 * deltaTime;
        onJoystickMove(dx, dy);
      }

      animationFrameRef.current = requestAnimationFrame(updateLoop);
    };

    animationFrameRef.current = requestAnimationFrame(updateLoop);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [connectionState, joystickMultiplier, onJoystickMove]);

  return (
    <div className="mobile-controller">
      <div className="mobile-status">
        <span className={`status-dot ${connectionState === 'connected' ? 'connected' : connectionState === 'connecting' ? 'connecting' : 'disconnected'}`} />
        <span>{connectionState === 'connected' ? 'Connected' : connectionState === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
      </div>
      <div 
        ref={joystickRef}
        className="joystick-container"
        onTouchStart={(e) => {
          if (e.touches.length > 0) {
            handleStart(e.touches[0].clientX, e.touches[0].clientY);
          }
        }}
        onMouseDown={(e) => {
          handleStart(e.clientX, e.clientY);
        }}
      >
        <div className="joystick-base">
          <div 
            ref={knobRef}
            className="joystick-knob"
            style={{
              transform: `translate(calc(-50% + ${knobPosition.x}px), calc(-50% + ${knobPosition.y}px))`,
            }}
          />
        </div>
      </div>
      <p className="mobile-instruction">Move the joystick to control your cursor</p>
    </div>
  );
}

function ViewerMode({
  cursors,
  averageCursor,
  groupAverages,
  displayMode,
  targetState,
  targetVisible,
  taskMode,
  yesNoAreas,
  broadcastMessages,
  circleTargetRadius,
  guideTrackingRunning,
  participantCursorSize,
  averageCursorSize,
  circleTargetSize,
  randomTargetSize,
  werewolfCursors,
}: {
  cursors: CursorState[];
  averageCursor: { x: number; y: number } | null;
  groupAverages: Map<number, { x: number; y: number }>;
  displayMode: DisplayMode;
  targetState: TargetState;
  targetVisible: boolean;
  taskMode: TaskMode;
  yesNoAreas: YesNoAreasState;
  broadcastMessages: Array<BroadcastMessage & { id: string }>;
  circleTargetRadius: number;
  guideTrackingRunning: boolean;
  participantCursorSize: number;
  averageCursorSize: number;
  circleTargetSize: number;
  randomTargetSize: number;
  werewolfCursors: Array<{ identity: string; x: number; y: number }>;
}) {
  const showAverageCursor = averageCursor !== null && (displayMode === 'avgOnly' || displayMode === 'all-with-avg-lines' || displayMode === 'all-with-avg-no-lines' || displayMode === 'self-with-avg');
  const showLines = displayMode === 'all-with-avg-lines';
  const isGrouped = groupAverages.size > 0;

  // 'self' / 'self-with-avg' modes hide other participants' cursors. ViewerMode
  // has no own cursor, so for these we render no participant cursors (only the
  // avg, when visible).
  const visibleCursors = (displayMode === 'avgOnly' || displayMode === 'self' || displayMode === 'self-with-avg') ? [] : cursors;
  const showWolfCursors = werewolfCursors.length > 0 && (displayMode === 'all-without-avg' || displayMode === 'all-with-avg-lines' || displayMode === 'all-with-avg-no-lines');

  // Build TaskStage element arrays. ViewerMode always shows displayName labels,
  // uses #3b82f6 for the single average (vs the main stage's #1d4ed8) and
  // dashed light-blue lines.
  const stageCursors: P5Dot[] = [];
  for (const c of visibleCursors) {
    stageCursors.push({
      id: c.identity,
      x: c.x,
      y: c.y,
      diameter: participantCursorSize,
      fill: c.color,
      label: { text: c.displayName, color: 'rgba(30, 41, 59, 0.6)' },
    });
  }
  if (showWolfCursors) {
    for (const wolf of werewolfCursors) {
      stageCursors.push({
        id: wolf.identity,
        x: wolf.x,
        y: wolf.y,
        diameter: participantCursorSize,
        fill: colorFromIdentity(wolf.identity),
        label: { text: wolf.identity, color: 'rgba(30, 41, 59, 0.6)' },
      });
    }
  }

  const stageAverages: P5Dot[] = [];
  if (showAverageCursor) {
    if (isGrouped) {
      for (const [gid, pos] of groupAverages.entries()) {
        stageAverages.push({
          id: `group-avg-${gid}`,
          x: pos.x,
          y: pos.y,
          diameter: averageCursorSize,
          fill: colorForGroup(gid),
          label: { text: `G${gid} Avg`, color: 'rgba(30, 41, 59, 0.6)' },
        });
      }
    } else if (averageCursor) {
      stageAverages.push({
        id: 'avg',
        x: averageCursor.x,
        y: averageCursor.y,
        diameter: averageCursorSize,
        fill: '#3b82f6',
        label: { text: 'Average', color: 'rgba(30, 41, 59, 0.6)' },
      });
    }
  }

  const stageLines: P5Line[] = (showAverageCursor && showLines && !isGrouped && averageCursor)
    ? visibleCursors.map((c) => ({
        x1: c.x,
        y1: c.y,
        x2: averageCursor.x,
        y2: averageCursor.y,
        color: 'rgba(59, 130, 246, 0.3)',
        width: 2,
        dashed: true,
      }))
    : [];

  // ViewerMode renders the target shape from the message itself (not the
  // task mode). Triangle/square use circleTargetSize; circle uses
  // randomTargetSize — preserved from the legacy DOM render.
  const stageTarget: P5Target | null = (
    targetVisible
    && (taskMode === 'target-tracking'
      || taskMode === 'circle-target-tracking'
      || taskMode === 'random-target-tracking'
      || taskMode === 'reaching')
  ) ? {
    x: targetState.x,
    y: targetState.y,
    shape: targetState.shape,
    size: targetState.shape === 'circle' ? randomTargetSize : circleTargetSize,
    fill: targetState.color ?? '#dc2626',
  } : null;

  const stageGuide: P5Guide | null = (taskMode === 'guide-tracking' && guideTrackingRunning)
    ? { cx: 0.5, cy: 0.5, radius: circleTargetRadius, stroke: '#8b0000', strokeWidth: 4 }
    : null;

  const stageYesNo: P5YesNo | null = yesNoAreas.visible
    ? { yesPosition: yesNoAreas.yesPosition, noPosition: yesNoAreas.noPosition, size: 80 }
    : null;

  return (
    <div className="viewer-mode">
      <div className="viewer-stage">
        <TaskStage
          taskMode={taskMode}
          cursors={stageCursors}
          averages={stageAverages}
          lines={stageLines}
          target={stageTarget}
          guide={stageGuide}
          yesNo={stageYesNo}
        />

        {broadcastMessages.filter((m) => m.position !== 'bottom').map((msg) => (
          <div
            key={msg.id}
            style={{
              position: 'absolute',
              ...(msg.position === 'top' ? {
                top: '12px',
                left: '50%',
                transform: 'translateX(-50%)',
              } : {
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
              }),
              background: msg.position === 'top' ? 'transparent'
                : msg.severity === 'error' ? 'rgba(220, 38, 38, 0.5)' : msg.severity === 'warning' ? 'rgba(245, 158, 11, 0.5)' : 'rgba(59, 130, 246, 0.5)',
              color: msg.position === 'top' ? '#374151' : 'white',
              padding: msg.position === 'top' ? '0.25rem 0.75rem' : '1rem 2rem',
              borderRadius: '0.5rem',
              fontSize: msg.position === 'top' ? '0.85rem' : '2.5rem',
              fontWeight: msg.position === 'top' ? '500' : 'bold',
              whiteSpace: msg.position === 'top' ? 'pre-line' : undefined,
              zIndex: 2500,
              pointerEvents: 'none',
              textAlign: 'center',
              maxWidth: '90%',
            }}
          >
            {msg.text}
          </div>
        ))}
        {broadcastMessages.filter((m) => m.position === 'bottom').map((msg) => (
          <div key={msg.id} className="stage-bottom-instruction">
            {msg.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileEntryScreen({ onSubmit }: { onSubmit: (username: string) => void }) {
  const [username, setUsername] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (username.trim()) {
      onSubmit(username.trim());
    }
  };

  return (
    <div className="mobile-entry-screen">
      <div className="mobile-entry-content">
        <h1>Cursor Experiment</h1>
        <h2>Mobile Controller</h2>
        <form onSubmit={handleSubmit}>
          <label>
            Enter your username (PROLIFIC_PID):
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your ID"
              autoFocus
            />
          </label>
          <button type="submit" className="primary" disabled={!username.trim()}>
            Join Experiment
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const isSimMode = urlParams.has('sim');
  const adminParam = urlParams.get('admin');
  const isDatabaseAdmin = adminParam === 'database';
  const isAgentAdmin = adminParam === 'agent';
  const isViewerMode = adminParam === 'viewer';
  const isMainAdminPage = adminParam !== null && !isDatabaseAdmin && !isAgentAdmin && !isViewerMode;
  const isMobileMode = urlParams.get('device') === 'mobile';
  
  if (isDatabaseAdmin) {
    return <DatabaseAdmin />;
  }
  
  if (isAgentAdmin) {
    return <AgentAdmin />;
  }
  
  const [hasConsented, setHasConsented] = useState(() => {
    if (isMobileMode && typeof window !== 'undefined') {
      return sessionStorage.getItem('mobile_username') !== null;
    }
    // Dev / test helper: `?autoConnect=1` (typically together with
    // `?admin=<ADMIN_PASSWORD>`) pre-consents so the headless test harness can
    // open an admin tab that auto-connects to the room without a click.
    if (urlParams.get('autoConnect') === '1') {
      return true;
    }
    return false;
  });
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [tokenServerUrl, setTokenServerUrl] = useState(() => defaultServer);
  const [roomName, setRoomName] = useState('joint-cursor-task2');
  const [identityInput, setIdentityInput] = useState(() => {
    if (isMobileMode && typeof window !== 'undefined') {
      return sessionStorage.getItem('mobile_username') || '';
    }
    const pid = urlParams.get('PID') || urlParams.get('pid') || urlParams.get('PROLIFIC_PID');
    return pid || '';
  });
  const prolificStudyId = urlParams.get('STUDY_ID') || urlParams.get('study_id') || '';
  const prolificSubmissionId = urlParams.get('SESSION_ID') || urlParams.get('session_id') || '';
  const [adminPassword, setAdminPassword] = useState(() => {
    return isMainAdminPage ? adminParam ?? '' : '';
  });
  const [isAdmin, setIsAdmin] = useState(isSimMode);
  const [showAdvanced, setShowAdvanced] = useState(() => isMainAdminPage || isSimMode);
  const [dummyEnabled, setDummyEnabled] = useState(() => {
    const dummyParam = urlParams.get('dummy');
    return urlParams.has('dummy') && dummyParam !== '0' && dummyParam?.toLowerCase() !== 'false';
  });
  const [error, setError] = useState<string | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSession, setRecordingSession] = useState<RecordingSession | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(
    urlParams.has('admin') || isSimMode ? 'all-without-avg' : 'self',
  );
  const [hideCursor, setHideCursor] = useState(true);
  const [broadcastMessages, setBroadcastMessages] = useState<Array<BroadcastMessage & { id: string }>>([]);
  const [participantExperimentFlowStarted, setParticipantExperimentFlowStarted] = useState(false);
  const [task7AdminStartObserved, setTask7AdminStartObserved] = useState(false);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastDuration, setBroadcastDuration] = useState(5000);
  const [chatMessages, setChatMessages] = useState<Array<ChatMessage & { id: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [isMouseOutsideStage, setIsMouseOutsideStage] = useState(false);
  const [isInactive, setIsInactive] = useState(false);
  const [participantLog, setParticipantLog] = useState<ParticipantLogEvent[]>([]);
  const [localRttMs, setLocalRttMs] = useState<number | null>(null);
  const [latencyByIdentity, setLatencyByIdentity] = useState<Map<string, number>>(new Map());

  // Latency check modal state (participants only). Measures LiveKit RTT for
  // 10s before allowing participation; gates the consent screen. Local Vite
  // development skips the gate because the local LiveKit setup is not an
  // internet-speed measurement and may not expose a usable WebRTC path.
  const skipLatencyCheck = import.meta.env.DEV
    || isSimMode
    || isMobileMode
    || isViewerMode
    || isMainAdminPage
    || urlParams.get('skipLatency') === '1';
  // Threshold for the median RTT (ms). Fetched from the server (which reads
  // it from the agent's experiment config, set on the agent admin page).
  // Falls back to DEFAULT_LATENCY_THRESHOLD_MS if the fetch fails.
  const [latencyThresholdMs, setLatencyThresholdMs] = useState<number>(DEFAULT_LATENCY_THRESHOLD_MS);
  const [latencyCheckPassed, setLatencyCheckPassed] = useState<boolean>(skipLatencyCheck);
  const [latencyMeasuring, setLatencyMeasuring] = useState(false);
  const [latencyMeasurement, setLatencyMeasurement] = useState<{ max: number; avg: number; median: number; sampleCount: number } | null>(null);
  const [latencyMeasureError, setLatencyMeasureError] = useState<string | null>(null);
  const [latencyMeasureProgress, setLatencyMeasureProgress] = useState(0);
  const [latencyCurrentRttMs, setLatencyCurrentRttMs] = useState<number | null>(null);
  const [participantStatusByIdentity, setParticipantStatusByIdentity] = useState<Map<string, { isPointerLocked: boolean; isUsingVirtualCursor: boolean }>>(new Map());
  const [liveKitParticipants, setLiveKitParticipants] = useState<Map<string, LiveKitParticipant>>(new Map());
  const isParticipantPage = !urlParams.has('admin') && !isMobileMode && !isSimMode;
  const initialTaskMode: TaskMode = isMainAdminPage ? 'shared-single-cursor' : 'manual-instruction';
  const initialExperimentTaskType: ExperimentTaskType | null = getInitialExperimentTaskType(
    isMainAdminPage,
    isParticipantPage,
  );
  const [taskMode, setTaskMode] = useState<TaskMode>(initialTaskMode);
  /**
   * The experiment-task type (when known) — set by the server agent at trial
   * start via `agentStartRecording`. Used to disambiguate sketches that share
   * the same `taskMode` (e.g. circle-target-tracking vs group-circle-target-
   * tracking) when selecting the active sketch and its visual style.
   * Null outside agent-driven trials; falls back to TaskMode-based lookup.
   */
  const [experimentTaskType, setExperimentTaskType] = useState<ExperimentTaskType | null>(initialExperimentTaskType);
  // Group assignments (used by group-* tasks). Empty assignments + groupCount=1
  // means "no grouping" — averageCursor falls back to all participants.
  const [groupAssignments, setGroupAssignments] = useState<GroupAssignmentsState>({ assignments: {}, groupCount: 1 });
  const [targetState, setTargetState] = useState<TargetState>({ x: 0.5, y: 0.5, shape: 'triangle' });
  const targetStateRef = useRef<TargetState>({ x: 0.5, y: 0.5, shape: 'triangle' });
  const targetVisibleRef = useRef(true);
  const groupAssignmentsRef = useRef<GroupAssignmentsState>({ assignments: {}, groupCount: 1 });
  const [targetVisible, setTargetVisible] = useState(true);

  // Keep refs in sync with state so captureFrame always reads latest values
  useEffect(() => { targetStateRef.current = targetState; }, [targetState]);
  useEffect(() => { targetVisibleRef.current = targetVisible; }, [targetVisible]);
  const taskModeRef = useRef<TaskMode>(initialTaskMode);
  useEffect(() => { taskModeRef.current = taskMode; }, [taskMode]);
  const experimentTaskTypeRef = useRef<ExperimentTaskType | null>(initialExperimentTaskType);
  useEffect(() => { experimentTaskTypeRef.current = experimentTaskType; }, [experimentTaskType]);

  /**
   * Visuomotor rotation (radians) applied to virtual cursor input deltas
   * during pointer-locked mode. Set via the `setCursorRotation` control
   * message (used by the reaching task). 0 means no rotation.
   */
  const cursorRotationRadRef = useRef<number>(0);

  /**
   * Cursor input gain — multiplier applied to pointer-lock delta before
   * any rotation. Driven by the active sketch's `inputs.cursorGain`
   * (see `experiments/<task-id>/sketch.ts`). Default 1.0 = no scaling.
   *
   * The sketch owns this value; there's no server-side control message
   * for cursor gain in v1. If future tasks need agent-driven dynamic
   * gain changes, add a `setCursorGain` control message analogous to
   * `setCursorRotation`.
   */
  const cursorGainRef = useRef<number>(1);

  /**
   * Mirror of the resolved active sketch (computed by `activeSketch`
   * useMemo later in this component). Declared here so the room data
   * listener's control-message handler can read the *current* sketch
   * synchronously when handling `startSketchTrajectory` /
   * `startSketchHitDetector`. Initial value null; useEffect below
   * `activeSketch` keeps it in sync.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeSketchRef = useRef<any>(null);

  /**
   * Interval timer id for the admin-side sketch trajectory publish loop.
   * Installed when `startSketchTrajectory` control msg arrives; cleared on
   * `stopSketchTrajectory` (and on unmount via the cleanup useEffect
   * placed near `activeSketch`).
   */
  const sketchTrajectoryTimerRef = useRef<number | null>(null);

  /**
   * Interval timer id for the admin-side sketch hit-detector polling loop.
   * Lifetime parallels the trajectory timer.
   */
  const sketchHitTimerRef = useRef<number | null>(null);

  /**
   * Coordinate-frame offset applied to the displayed avg cursor.
   *   displayedAvg = rawAvg - avgCursorOffset
   * Set by the agent via the `setAvgCursorOffset` control message — used by
   * the reaching task so the displayed avg cursor appears at a fixed start
   * position (e.g. (0.5, 0.8)) at trial start, regardless of where the
   * participants' actual cursors are. Default (0, 0) = no shift.
   */
  const avgCursorOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [avgCursorOffset, setAvgCursorOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [sharedCursorControl, setSharedCursorControl] = useState<{
    enabled: boolean;
    phase: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
    matrix: number[];
    visualGain: number;
    disturbance: CursorControlDisturbance | null;
  }>({
    enabled: false,
    phase: 'shared',
    matrix: [0.5, 0, 0.5, 0, 0, 0.5, 0, 0.5],
    visualGain: 1,
    disturbance: null,
  });
  const sharedCursorControlRef = useRef(sharedCursorControl);
  useEffect(() => { sharedCursorControlRef.current = sharedCursorControl; }, [sharedCursorControl]);
  const [sharedDisturbanceStartedAt, setSharedDisturbanceStartedAt] = useState<number | null>(null);
  const [task9SharedFeedbackEnabled, setTask9SharedFeedbackEnabled] = useState(false);
  const [sharedQuestionnaire, setSharedQuestionnaire] = useState<{
    visible: boolean;
    trialNumber: number;
    kind: 'legacy' | 'contribution';
    agency: number | null;
    partnership: number | null;
    contribution: number | null;
    submitted: boolean;
    submitting: boolean;
  }>({
    visible: false,
    trialNumber: 0,
    kind: 'legacy',
    agency: null,
    partnership: null,
    contribution: null,
    submitted: false,
    submitting: false,
  });
  const [sharedCursorVisualHidden, setSharedCursorVisualHidden] = useState(false);
  const [sharedCursorNativeHidden, setSharedCursorNativeHidden] = useState(false);
  const [sharedQuestionnaireWaiting, setSharedQuestionnaireWaiting] = useState(false);
  const [participantStartClicked, setParticipantStartClicked] = useState(false);
  const [participantStartRequestPending, setParticipantStartRequestPending] = useState(false);
  const [participantStartError, setParticipantStartError] = useState<string | null>(null);
  const sharedQuestionnaireRevealRequestRef = useRef(0);
  const [task9Score, setTask9Score] = useState<{
    trialKey: string;
    trialNumber: number;
    phase: string | undefined;
    score: number;
  } | null>(null);
  const sharedCursorTransitionTimerRef = useRef<number | null>(null);
  const clearSharedCursorTransitionTimer = useCallback(() => {
    if (sharedCursorTransitionTimerRef.current !== null) {
      window.clearTimeout(sharedCursorTransitionTimerRef.current);
      sharedCursorTransitionTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => {
    if (sharedCursorTransitionTimerRef.current !== null) {
      window.clearTimeout(sharedCursorTransitionTimerRef.current);
      sharedCursorTransitionTimerRef.current = null;
    }
    for (const timer of sharedTrackingCompletionTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    sharedTrackingCompletionTimersRef.current.clear();
  }, []);

  // Safety: when leaving the reaching task, clear leftover visuomotor rotation
  // and avg-cursor offset so participants don't end up stuck in a shifted
  // coordinate frame after the agent stops or moves to a different phase.
  useEffect(() => {
    if (taskMode !== 'reaching') {
      cursorRotationRadRef.current = 0;
      avgCursorOffsetRef.current = { x: 0, y: 0 };
      setAvgCursorOffset({ x: 0, y: 0 });
    }
  }, [taskMode]);
  // Safety: clear experimentTaskType when the underlying taskMode no longer
  // matches any of its appliesTo entries. Prevents a stale ExperimentTaskType
  // from forcing the wrong sketch style after an out-of-band taskMode change.
  useEffect(() => {
    if (!experimentTaskType) return;
    if (isCursorControlExperimentTask(experimentTaskType) && taskMode === 'manual-instruction') {
      return;
    }
    const sk = getSketchByExperimentTask(experimentTaskType);
    if (!sk || !sk.appliesTo.includes(taskMode)) {
      setExperimentTaskType(null);
    }
  }, [taskMode, experimentTaskType]);
  useEffect(() => { groupAssignmentsRef.current = groupAssignments; }, [groupAssignments]);
  const [circleTargetPeriod, setCircleTargetPeriod] = useState(5000);
  const [circleTargetRadius, setCircleTargetRadius] = useState(0.3);
  const [circleTargetDuration, setCircleTargetDuration] = useState(30000);
  const [circleTargetRunning, setCircleTargetRunning] = useState(false);
  const [circleTargetElapsedTime, setCircleTargetElapsedTime] = useState(0);
    const [circleTargetTimerActive, setCircleTargetTimerActive] = useState(false);
    const [guideTrackingRunning, setGuideTrackingRunning] = useState(false);
    const [guideTrackingElapsedTime, setGuideTrackingElapsedTime] = useState(0);
    const [guideTrackingTimerActive, setGuideTrackingTimerActive] = useState(false);
    const [virtualCursorPos, setVirtualCursorPos] = useState({ x: 0.5, y: 0.5 });
    const [useVirtualCursor, setUseVirtualCursor] = useState(false);
    const [yesNoAreas, setYesNoAreas] = useState<YesNoAreasState>({
      visible: false,
      yesPosition: { x: 0.3, y: 0.5 },
      noPosition: { x: 0.7, y: 0.5 },
    });
    const [showClickAreaOverlay, setShowClickAreaOverlay] = useState(false);
    const [isPointerLocked, setIsPointerLocked] = useState(false);
    const [task7PointerLockRecoveryRequired, setTask7PointerLockRecoveryRequired] = useState(false);
    const activeSharedTrackingTrialKeyRef = useRef<string | null>(null);
    const task9InterTrialPointerLockGuardRef = useRef(false);
    const [sharedTrackingEscInterrupted, setSharedTrackingEscInterrupted] = useState(false);
    const sharedTrackingEscInterruptedRef = useRef(false);
    const [isKicked, setIsKicked] = useState(false);
    const [participantTerminationOutcome, setParticipantTerminationOutcome] = useState<{
      disposition: 'return-no-payment' | 'partner-compensation-review';
      reason: string;
      elapsedSeconds: number;
    } | null>(null);
    // Consent-screen deadline: participants must complete the latency check +
    // consent within the configured time limit, otherwise
    // they are auto-withdrawn (since the experiment runs in real time and
    // late entrants cannot be slotted into an in-progress session).
    const [participationCancelled, setParticipationCancelled] = useState(false);
    const [participationCancelledReason, setParticipationCancelledReason] = useState<'deadline' | 'declined'>('deadline');
    const [consentSecondsRemaining, setConsentSecondsRemaining] = useState(CONSENT_DEADLINE_SECONDS);
    const [experimentName, setExperimentName] = useState('');
    const [trialNumber, setTrialNumber] = useState(1);
    const [recordingDatabaseRefreshKey, setRecordingDatabaseRefreshKey] = useState(0);
    const [uploadProgress, setUploadProgress] = useState<number | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
    const [mobileUsername, setMobileUsername] = useState<string | null>(() => {
      if (isMobileMode && typeof window !== 'undefined') {
        return sessionStorage.getItem('mobile_username');
      }
      return null;
    });
    const [joystickMultiplier, setJoystickMultiplier] = useState(1.0);
    const [mobileCursorPos, setMobileCursorPos] = useState({ x: 0.5, y: 0.5 });
    const [participantCursorSize, setParticipantCursorSize] = useState(18);
    const [averageCursorSize, setAverageCursorSize] = useState(22);
    const [adminMode, setAdminMode] = useState<'experiment' | 'demo'>('experiment');
    const [leftPanelWidth, setLeftPanelWidth] = useState(380);
    const [rightPanelWidth, setRightPanelWidth] = useState(360);
    const resizingRef = useRef<'left' | 'right' | null>(null);
    const resizeStartXRef = useRef(0);
    const resizeStartWidthRef = useRef(0);
    const [demoRunning, setDemoRunning] = useState(false);
    const [demoElapsedSeconds, setDemoElapsedSeconds] = useState(0);
    const demoStartTimeRef = useRef<number | null>(null);
    const demoTimerRef = useRef<number | null>(null);
    const randomTargetTrajectoryRef = useRef<RandomTargetTrajectory | null>(null);
    const randomTargetStartTimeRef = useRef<number | null>(null);
    const [randomTargetRunning, setRandomTargetRunning] = useState(false);
    const [circleTargetSize, setCircleTargetSize] = useState(30);
    const [randomTargetSize, setRandomTargetSize] = useState(24);
    const [randomTargetElapsedTime, setRandomTargetElapsedTime] = useState(0);
    const virtualCursorPosRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
    const mobileCursorPosRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
    const localIdentityRef = useRef<string>('');

    const demoRunningRef = useRef(false);
    useEffect(() => { demoRunningRef.current = demoRunning; }, [demoRunning]);

    // Werewolf cursor state
    const [werewolfEnabled, setWerewolfEnabled] = useState(false);
    const werewolfEnabledRef = useRef(false);
    useEffect(() => { werewolfEnabledRef.current = werewolfEnabled; }, [werewolfEnabled]);
    const latencyByIdentityRef = useRef<Map<string, number>>(new Map());
    useEffect(() => { latencyByIdentityRef.current = latencyByIdentity; }, [latencyByIdentity]);
    const [werewolfCount, setWerewolfCount] = useState(2);
    const [werewolfNoise, setWerewolfNoise] = useState(0.06);
    const [werewolfSpeed, setWerewolfSpeed] = useState(0.1);
    const [werewolfRadius, setWerewolfRadius] = useState(0.25);
    const werewolfCursorsRef = useRef<WerewolfCursorState[]>([]);
    const werewolfAnimRef = useRef<number | null>(null);
    // Received werewolf cursors from admin (for viewer/participant)
    const receivedWerewolfCursorsRef = useRef<Array<{ identity: string; x: number; y: number }>>([]);
    const werewolfPublishTimerRef = useRef<number>(0);

    const templateMessages = [
    'We are waiting for other participants to join. The experiment will begin in a few minutes.',
    'Until the main task begins, please continue moving your cursor to the triangular targets appearing on the screen.',
    'This is to measure your baseline motor performance.',
    '30-second break.',
    'Thank you for your participation. The main task will now begin.',
    'Your cursor is now visible.',
    'We need to switch your cursor to the virtual cursor used for this experiment.',
    'Please click the center of the screen. Your system pointer will be locked, and it will switch to the virtual cursor within the experimental area.',
    'Pressing the ESC key will unlock the pointer, so please do not press it during the experiment.',
    'After the experiment is finished, you will return to your standard system pointer.',
    'The cursors of other participants will now be displayed on the screen.',
    'Can you see the other participants\' cursors?',
    'Next, we will display the "Average Cursor" to be used in the experiment.',
    'The Average Cursor represents the mean position of all participants\' cursors.',
    'In the upcoming tasks, only this Average Cursor will be displayed.',
    'We will now hide the Average Cursor and the other participants\' cursors before explaining the task.',
    'Your task is to "use the Average Cursor to move in a continuous circle on the screen for a set period of time."',
    'There are no specific requirements for movement speed or direction. Please continue moving in a circle until the task is complete.',
    'A message will appear like this when the task starts and ends.',
    'You will perform this task for a total of three trials.',
    'The trial will start soon.',
    'Trial X of Y is complete.',
    'All trials are now complete.',
    'We are currently verifying and uploading your data. Please wait.',
    'The experiment ends. Thank you for your participation.',
    'You will now be redirected to the reward claim page.',
  ];

  const roomRef = useRef<Room | null>(null);
  const disconnectRef = useRef<(() => Promise<void>) | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cursorsRef = useRef<Map<string, CursorState>>(new Map());
  const lastSendRef = useRef({ time: 0, x: 0, y: 0, initialized: false });
  const lastMovementTimeRef = useRef<number>(Date.now());
  const isAdminRef = useRef(false);
  const recordingSessionRef = useRef<RecordingSession | null>(null);
  const recordingIntervalRef = useRef<number | null>(null);
  const recordingTickerStopRef = useRef<(() => void) | null>(null);
  const adminEventsRef = useRef<AdminEvent[]>([]);
  const templateWindowRef = useRef<Window | null>(null);
  const dummyParamsRef = useRef<{
    start: number;
    a: number;
    b: number;
    phase: number;
    Ax: number;
    Ay: number;
    speed: number;
    raf: number | null;
  } | null>(null);
    const circleTargetStartTimeRef = useRef<number | null>(null);
    const sendCursorRef = useRef<((x: number, y: number, forceSend?: boolean) => void) | null>(null);
    const isPointerLockedRef = useRef(false);
    const useVirtualCursorRef = useRef(false);
    const participantExperimentFlowStartedRef = useRef(false);
    const suppressParticipantWithdrawReportRef = useRef(false);
    const participantWithdrawReportedRef = useRef(false);

    useEffect(() => {
      isAdminRef.current = isAdmin;
    }, [isAdmin]);

    useEffect(() => {
      isPointerLockedRef.current = isPointerLocked;
    }, [isPointerLocked]);

    useEffect(() => {
      useVirtualCursorRef.current = useVirtualCursor;
    }, [useVirtualCursor]);

    useEffect(() => {
      participantExperimentFlowStartedRef.current = participantExperimentFlowStarted;
    }, [participantExperimentFlowStarted]);

  // identityInput, hasConsented, and mobileUsername are now initialized
  // synchronously from URL params / sessionStorage in their useState initializers,
  // so no useEffect is needed for identity restoration.

  const cursorList = useMemo(() => Array.from(cursorsRef.current.values()), [renderVersion]);
  const realParticipantConnectionCount = useMemo(
    () => Array.from(liveKitParticipants.values()).filter(isExperimentParticipantConnection).length,
    [liveKitParticipants],
  );
  const realLiveKitParticipants = useMemo(
    () => Array.from(liveKitParticipants.values()).filter(isExperimentParticipantConnection),
    [liveKitParticipants],
  );
  const allParticipantsPointerLocked = useMemo(() => {
    if (realLiveKitParticipants.length < 2) return false;
    const localIdentity = localIdentityRef.current;
    return realLiveKitParticipants.every((participant) => {
      if (participant.identity === localIdentity) {
        return isPointerLocked;
      }
      return participantStatusByIdentity.get(participant.identity)?.isPointerLocked === true;
    });
  }, [isPointerLocked, participantStatusByIdentity, realLiveKitParticipants]);
  const experimentParticipantIdentitySet = useMemo(
    () => new Set(realLiveKitParticipants.map((participant) => participant.identity)),
    [realLiveKitParticipants],
  );
  const experimentParticipantIdentitySetRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    experimentParticipantIdentitySetRef.current = experimentParticipantIdentitySet;
  }, [experimentParticipantIdentitySet]);

  /**
   * Raw average of participant cursors (and werewolves where applicable).
   * This is what the admin reports to the agent at 10Hz. The displayed avg
   * cursor is `rawAverageCursor - avgCursorOffset` (see `averageCursor` below).
   */
  const rawAverageCursor = useMemo(() => {
    // Determine the participant's group (if any). Admin/viewer don't have a group;
    // they fall through to the default "all cursors" branch.
    const localIdentity = localIdentityRef.current;
    const myGroupId = !isAdmin && !isViewerMode
      ? groupAssignments.assignments[localIdentity]
      : undefined;
    const isGrouped = myGroupId !== undefined;

    // Build the cursor set used for the average:
    //   • Admin/Viewer: all cursors except own (own excluded since they don't track)
    //   • Grouped participant: only cursors in the same group
    //   • Ungrouped participant: all cursors (legacy/non-group experiments)
    const experimentCursors = experimentParticipantIdentitySet.size > 0
      ? cursorList.filter((cursor) => experimentParticipantIdentitySet.has(cursor.identity))
      : cursorList.filter((cursor) => !cursor.identity.startsWith('admin:') && !isSyntheticParticipantIdentity(cursor.identity));
    let cursorsForAverage;
    if (isAdmin || isViewerMode) {
      cursorsForAverage = experimentCursors.filter((cursor) => !cursor.isLocal);
    } else if (isGrouped) {
      cursorsForAverage = experimentCursors.filter(
        (cursor) => groupAssignments.assignments[cursor.identity] === myGroupId,
      );
    } else {
      cursorsForAverage = experimentCursors;
    }

    // Include werewolf cursors in average:
    // Admin uses locally-computed werewolf cursors; viewer/participant uses received werewolf cursors.
    // Grouped participants ignore werewolves (werewolves don't belong to any group).
    const activeWerewolves = isGrouped
      ? []
      : isAdmin
        ? ((demoRunning && werewolfEnabled && (taskMode === 'circle-target-tracking' || taskMode === 'guide-tracking'))
          ? werewolfCursorsRef.current
          : [])
        : receivedWerewolfCursorsRef.current;

    const totalCount = cursorsForAverage.length + activeWerewolves.length;
    if (totalCount === 0) {
      return null;
    }
    const sum = cursorsForAverage.reduce(
      (acc, cursor) => {
        acc.x += cursor.x;
        acc.y += cursor.y;
        return acc;
      },
      { x: 0, y: 0 },
    );
    for (const wolf of activeWerewolves) {
      sum.x += wolf.x;
      sum.y += wolf.y;
    }
    return {
      x: sum.x / totalCount,
      y: sum.y / totalCount,
    };
  }, [cursorList, isAdmin, isViewerMode, demoRunning, werewolfEnabled, taskMode, renderVersion, groupAssignments, experimentParticipantIdentitySet]);

  /**
   * Displayed average cursor — `rawAverageCursor` shifted by `avgCursorOffset`.
   * For non-reaching tasks the offset is (0, 0), so this equals the raw avg.
   * For reaching, the offset is recalibrated at every trial start so this
   * appears at the configured start position (e.g. (0.5, 0.8)) at that moment.
   */
  const averageCursor = useMemo(() => {
    if (!rawAverageCursor) return null;
    return {
      x: rawAverageCursor.x - avgCursorOffset.x,
      y: rawAverageCursor.y - avgCursorOffset.y,
    };
  }, [rawAverageCursor, avgCursorOffset]);

  const sharedTaskCursor = useMemo(() => {
    if (!sharedCursorControl.enabled || taskMode !== 'shared-single-cursor') return null;
    const participants = cursorList
      .filter((cursor) => experimentParticipantIdentitySet.has(cursor.identity))
      .sort((a, b) => a.identity.localeCompare(b.identity));

    if (sharedCursorControl.phase === 'solo' || sharedCursorControl.phase === 'washout') {
      const local = participants.find((cursor) => cursor.identity === localIdentityRef.current);
      if (!local) return isAdmin ? participants[0] ?? null : null;
      return { x: local.x, y: local.y };
    }

    if (sharedCursorControl.phase === 'adaptation') {
      const local = participants.find((cursor) => cursor.identity === localIdentityRef.current);
      if (!local) return isAdmin ? participants[0] ?? null : null;
      const participantIndex = Math.max(0, participants.findIndex((cursor) => cursor.identity === local.identity));
      const alpha = disturbanceAlpha(sharedCursorControl.disturbance, sharedDisturbanceStartedAt);
      const params = interpolateDisturbanceParam(
        sharedCursorControl.disturbance?.participantStart?.[participantIndex],
        sharedCursorControl.disturbance?.participantEnd?.[participantIndex],
        alpha,
      );
      return applyCursorControlDisturbance(local, params, sharedCursorControl.disturbance?.type);
    }

    if (sharedCursorControl.phase === 'baseline') {
      return null;
    }

    if (participants.length < 2) return null;
    if (sharedCursorControl.disturbance?.enabled && sharedCursorControl.phase === 'shared') {
      const transformed = participants.slice(0, 2).map((cursor, index) => {
        const params = interpolateDisturbanceParam(
          sharedCursorControl.disturbance?.participantStart?.[index],
          sharedCursorControl.disturbance?.participantEnd?.[index],
          1,
        );
        const inputCursor = experimentTaskType === 'task8' && index === 1
          ? rotatePointClockwise90AroundCenter(cursor)
          : cursor;
        return applyCursorControlDisturbance(inputCursor, params, sharedCursorControl.disturbance?.type);
      });
      if (experimentTaskType === 'task8') {
        return {
          x: 0.5 + (transformed[0].x - 0.5) + (transformed[1].x - 0.5),
          y: 0.5 + (transformed[0].y - 0.5) + (transformed[1].y - 0.5),
        };
      }
      return {
        x: (transformed[0].x + transformed[1].x) / 2,
        y: (transformed[0].y + transformed[1].y) / 2,
      };
    }
    const [a, b] = participants;
    const m = sharedCursorControl.matrix;
    const ax = a.x - 0.5;
    const ay = a.y - 0.5;
    const bx = b.x - 0.5;
    const by = b.y - 0.5;
    return {
      x: 0.5 + (m[0] ?? 0.5) * ax + (m[1] ?? 0) * ay + (m[2] ?? 0.5) * bx + (m[3] ?? 0) * by,
      y: 0.5 + (m[4] ?? 0) * ax + (m[5] ?? 0.5) * ay + (m[6] ?? 0) * bx + (m[7] ?? 0.5) * by,
    };
  }, [sharedCursorControl, sharedDisturbanceStartedAt, taskMode, cursorList, isAdmin, renderVersion, experimentParticipantIdentitySet, experimentTaskType]);

  const displayedAverageCursor = sharedTaskCursor ?? averageCursor;
  const displayedAverageCursorRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { displayedAverageCursorRef.current = displayedAverageCursor; }, [displayedAverageCursor]);
  const shouldRotateTask8SharedDisplay = useMemo(() => {
    if (
      isAdmin
      || experimentTaskType !== 'task8'
      || taskMode !== 'shared-single-cursor'
      || !sharedCursorControl.enabled
      || sharedCursorControl.phase !== 'shared'
    ) {
      return false;
    }
    const participants = cursorList
      .filter((cursor) => experimentParticipantIdentitySet.has(cursor.identity))
      .sort((a, b) => a.identity.localeCompare(b.identity));
    return participants[1]?.identity === localIdentityRef.current;
  }, [
    cursorList,
    experimentParticipantIdentitySet,
    experimentTaskType,
    isAdmin,
    renderVersion,
    sharedCursorControl.enabled,
    sharedCursorControl.phase,
    taskMode,
  ]);

  /**
   * Mirror of `rawAverageCursor` for use in interval-driven effects (e.g. the
   * reaching task's avg-cursor reporting loop, which posts the *raw* avg to
   * the agent so the agent can apply the offset itself for reach detection).
   */
  const rawAverageCursorRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { rawAverageCursorRef.current = rawAverageCursor; }, [rawAverageCursor]);
  /** Mirror of the displayed `averageCursor` (rawAvg − offset). */
  const averageCursorRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { averageCursorRef.current = averageCursor; }, [averageCursor]);

  /**
   * Per-group average cursor positions. Empty map when there's no grouping
   * (groupCount <= 1) so the existing single-avg render path stays unchanged.
   * Used by:
   *   • Phase 4 (captureFrame): persisted in each FrameSnapshot
   *   • Phase 5 (admin/viewer rendering): shows one cursor per group
   * Werewolves are not included because they have no group.
   */
  // Ref mirror of groupAverages so sketch hit-detector / future per-frame
  // consumers can read the latest map synchronously without re-deriving.
  const groupAveragesRef = useRef<Map<number, { x: number; y: number }>>(new Map());

  const groupAverages = useMemo<Map<number, { x: number; y: number }>>(() => {
    const result = new Map<number, { x: number; y: number }>();
    if (groupAssignments.groupCount <= 1) return result;

    const cursorsForAvg = (isAdmin || isViewerMode)
      ? cursorList.filter((c) => !c.isLocal)
      : cursorList;

    type Sum = { x: number; y: number; count: number };
    const sums = new Map<number, Sum>();
    for (const cursor of cursorsForAvg) {
      const gid = groupAssignments.assignments[cursor.identity];
      if (gid === undefined) continue;
      const sum = sums.get(gid) ?? { x: 0, y: 0, count: 0 };
      sum.x += cursor.x;
      sum.y += cursor.y;
      sum.count += 1;
      sums.set(gid, sum);
    }
    for (const [gid, sum] of sums) {
      result.set(gid, { x: sum.x / sum.count, y: sum.y / sum.count });
    }
    return result;
  }, [cursorList, isAdmin, isViewerMode, groupAssignments, renderVersion]);
  useEffect(() => { groupAveragesRef.current = groupAverages; }, [groupAverages]);

  const bumpRender = useCallback(() => {
    setRenderVersion((value) => (value + 1) % Number.MAX_SAFE_INTEGER);
  }, []);

  const resetCursors = useCallback(() => {
    cursorsRef.current.clear();
    bumpRender();
  }, [bumpRender]);

  const upsertCursor = useCallback((identity: string, update: Partial<CursorState> & { x: number; y: number }) => {
    const existing = cursorsRef.current.get(identity);
    const next: CursorState = {
      identity,
      displayName: update.displayName ?? existing?.displayName ?? identity,
      color: update.color ?? existing?.color ?? colorFromIdentity(identity),
      x: update.x,
      y: update.y,
      updatedAt: update.updatedAt ?? Date.now(),
      isLocal: update.isLocal ?? existing?.isLocal ?? false,
      hash: update.hash ?? existing?.hash ?? hashIdentity(identity),
    };
    cursorsRef.current.set(identity, next);
    bumpRender();
  }, [bumpRender]);

  const removeCursor = useCallback((identity: string) => {
    if (cursorsRef.current.delete(identity)) {
      bumpRender();
    }
  }, [bumpRender]);

  const recordingFrameNumberRef = useRef(0);
  const pendingTrialMetadataRef = useRef<Record<string, unknown> | null>(null);
  const sharedTrackingStartsRef = useRef<Map<string, { trialKey: string; receivedAt: number }>>(new Map());
  const sharedTrackingCompletionTimersRef = useRef<Map<string, number>>(new Map());
  const captureFrameRef = useRef<(() => void) | null>(null);
  const stopDemoRef = useRef<() => void>(() => {});

  // Stable, ref-driven capture. No state deps — the ticker (Worker-backed)
  // calls this directly, so there is no stale-closure or "state not committed
  // yet" race between setIsRecording(true) and the first tick.
  const captureFrame = useCallback(() => {
    const session = recordingSessionRef.current;
    if (!session || !isAdminRef.current) {
      return;
    }

    const currentTaskMode = taskModeRef.current;
    const latencyMap = latencyByIdentityRef.current;

    const participantIdentities = experimentParticipantIdentitySetRef.current;
    const allCursors = Array.from(cursorsRef.current.values());
    const cursors = allCursors.filter((cursor) =>
      !cursor.isLocal
      && (participantIdentities.size === 0 || participantIdentities.has(cursor.identity)),
    );
    const currentGroups = groupAssignmentsRef.current;
    const isGrouped = currentGroups.groupCount > 1;

    const cursorSnapshots: CursorSnapshot[] = cursors.map((cursor) => {
      const snap: CursorSnapshot = {
        identity: cursor.identity,
        displayName: cursor.displayName,
        x: cursor.x,
        y: cursor.y,
        hash: cursor.hash,
        isLocal: cursor.isLocal,
        color: cursor.color,
        rttMs: latencyMap.get(cursor.identity) ?? null,
      };
      const gid = currentGroups.assignments[cursor.identity];
      if (gid !== undefined) snap.groupId = gid;
      return snap;
    });

    const activeWolves = (demoRunningRef.current && werewolfEnabledRef.current && (currentTaskMode === 'circle-target-tracking' || currentTaskMode === 'guide-tracking'))
      ? werewolfCursorsRef.current
      : [];
    for (const wolf of activeWolves) {
      cursorSnapshots.push({
        identity: wolf.identity,
        displayName: wolf.identity,
        x: wolf.x,
        y: wolf.y,
        hash: hashIdentity(wolf.identity),
        isLocal: false,
        color: colorFromIdentity(wolf.identity),
        rttMs: null,
      });
    }

    let average: { x: number; y: number } | null = null;
    const totalForAvg = cursors.length + activeWolves.length;
    if (totalForAvg > 0) {
      const sum = cursors.reduce(
        (acc, cursor) => {
          acc.x += cursor.x;
          acc.y += cursor.y;
          return acc;
        },
        { x: 0, y: 0 },
      );
      for (const wolf of activeWolves) {
        sum.x += wolf.x;
        sum.y += wolf.y;
      }
      average = {
        x: sum.x / totalForAvg,
        y: sum.y / totalForAvg,
      };
    }
    if (currentTaskMode === 'shared-single-cursor') {
      average = displayedAverageCursorRef.current;
    }

    // Compute per-group averages (group experiments only). Werewolves not included.
    let groupAvgs: Record<number, { x: number; y: number }> | undefined;
    if (isGrouped) {
      type Sum = { x: number; y: number; count: number };
      const sums = new Map<number, Sum>();
      for (const cursor of cursors) {
        const gid = currentGroups.assignments[cursor.identity];
        if (gid === undefined) continue;
        const sum = sums.get(gid) ?? { x: 0, y: 0, count: 0 };
        sum.x += cursor.x;
        sum.y += cursor.y;
        sum.count += 1;
        sums.set(gid, sum);
      }
      groupAvgs = {};
      for (const [gid, sum] of sums) {
        groupAvgs[gid] = { x: sum.x / sum.count, y: sum.y / sum.count };
      }
    }

    const currentTarget = targetStateRef.current;
    const currentTargetVisible = targetVisibleRef.current;
    let target: FrameSnapshot['target'] = currentTargetVisible && (currentTaskMode === 'target-tracking' || currentTaskMode === 'circle-target-tracking' || currentTaskMode === 'random-target-tracking' || currentTaskMode === 'reaching' || currentTaskMode === 'shared-single-cursor')
      ? { x: currentTarget.x, y: currentTarget.y, shape: currentTarget.shape }
      : null;
    let participantTargets: FrameSnapshot['participantTargets'];
    if (currentTaskMode === 'shared-single-cursor' && currentTargetVisible && currentTarget.trajectoryParams) {
      const trialKey = typeof currentTarget.trajectoryParams.trialKey === 'string'
        ? currentTarget.trajectoryParams.trialKey
        : '';
      const durationMs = Number(currentTarget.trajectoryParams.durationMs);
      const trajectory = getSketchByTaskMode('shared-single-cursor')?.trajectory;
      participantTargets = {};
      for (const cursor of cursors) {
        const start = sharedTrackingStartsRef.current.get(cursor.identity);
        if (!start || start.trialKey !== trialKey) {
          participantTargets[cursor.identity] = { x: 0.5, y: 0.5, shape: 'circle' };
          continue;
        }
        const elapsedMs = Math.max(0, Date.now() - start.receivedAt);
        if (Number.isFinite(durationMs) && elapsedMs >= durationMs) {
          participantTargets[cursor.identity] = null;
          continue;
        }
        const output = trajectory?.compute(elapsedMs, currentTarget.trajectoryParams);
        participantTargets[cursor.identity] = output
          ? { x: output.x, y: output.y, shape: 'circle' }
          : null;
      }
      const representativeTarget = Object.values(participantTargets).find((value) => value !== null) ?? null;
      target = representativeTarget
        ? { x: representativeTarget.x, y: representativeTarget.y, shape: representativeTarget.shape }
        : null;
    }

    const frame: FrameSnapshot = {
      timestamp: Date.now(),
      frameNumber: recordingFrameNumberRef.current++,
      cursors: cursorSnapshots,
      average,
      target,
      ...(participantTargets ? { participantTargets } : {}),
      ...(groupAvgs ? { groupAverages: groupAvgs } : {}),
    };

    session.frames.push(frame);
  }, []);

  useEffect(() => {
    captureFrameRef.current = captureFrame;
  }, [captureFrame]);

  useEffect(() => {
    if (!isRecording) {
      setRecordingElapsedSeconds(0);
      return;
    }
    const interval = window.setInterval(() => {
      if (recordingSessionRef.current) {
        const elapsed = Math.floor((Date.now() - recordingSessionRef.current.startTime) / 1000);
        setRecordingElapsedSeconds(elapsed);
      }
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [isRecording]);

  const logAdminEvent = useCallback((event: AdminEvent) => {
    if (!isAdminRef.current) {
      return;
    }
    adminEventsRef.current.push(event);
    
    if (recordingSessionRef.current) {
      const t = event.timestamp - recordingSessionRef.current.startTime;
      const exportEvent: AdminEventExport = { ...event, t };
      recordingSessionRef.current.events.push(exportEvent);
    }
  }, []);

  useEffect(() => {
    const updateDisplayedScore = (detail: Record<string, unknown>) => {
      const trialKey = typeof detail.trialKey === 'string' ? detail.trialKey : '';
      const score = Number(detail.score);
      if (trialKey && Number.isFinite(score)) {
        const trialNumber = Number(detail.trialNumber ?? 0);
        const phase = typeof detail.phase === 'string' ? detail.phase : undefined;
        setTask9Score({
          trialKey,
          trialNumber: Number.isFinite(trialNumber) ? trialNumber : 0,
          phase,
          score,
        });
      }
    };
    const handleScoreState = (event: Event) => {
      updateDisplayedScore((event as CustomEvent<Record<string, unknown>>).detail ?? {});
    };
    const handleScoreAcquired = (event: Event) => {
      const detail = (event as CustomEvent<Task9Acquisition & { trialNumber?: number; phase?: string }>).detail;
      if (!detail) return;
      if (detail.phase !== 'shared') {
        updateDisplayedScore(detail as unknown as Record<string, unknown>);
        return;
      }
      if (!isAdminRef.current) return;

      const currentTarget = targetStateRef.current;
      const now = Date.now();
      const nextParams = advanceTask9SharedTargetParams(
        currentTarget.trajectoryParams ?? {},
        detail,
        now,
      );
      if (!nextParams) return;

      const nextTarget: TargetState = {
        ...currentTarget,
        trajectoryParams: nextParams,
        trajectoryElapsedMs: 0,
        trajectoryReceivedAt: now,
      };
      targetStateRef.current = nextTarget;
      setTargetState(nextTarget);
      updateDisplayedScore(nextParams);

      const room = roomRef.current;
      if (room) {
        const message: TargetMessage = {
          type: 'target',
          x: nextTarget.x,
          y: nextTarget.y,
          shape: nextTarget.shape,
          color: nextTarget.color,
          trajectoryParams: nextParams,
          trajectoryElapsedMs: 0,
          timestamp: now,
        };
        const payload = new TextEncoder().encode(JSON.stringify(message));
        void room.localParticipant.publishData(payload, { reliable: true, topic: TARGET_TOPIC });
      }
      logAdminEvent({
        type: 'task9ScoreAcquired',
        timestamp: now,
        trialKey: detail.trialKey,
        trialNumber: Number(detail.trialNumber ?? 0),
        phase: detail.phase,
        score: Number(nextParams.score),
        sequence: Number(nextParams.sequence),
        targetIndex: detail.targetIndex,
        nextTargetIndex: detail.nextTargetIndex,
      });
    };

    window.addEventListener('task9-score-state', handleScoreState);
    window.addEventListener('task9-score-acquired', handleScoreAcquired);
    return () => {
      window.removeEventListener('task9-score-state', handleScoreState);
      window.removeEventListener('task9-score-acquired', handleScoreAcquired);
    };
  }, [logAdminEvent]);

  const startRecording = useCallback(() => {
    if (connectionState !== 'connected' && !isSimMode) {
      setError('Must be connected to start recording');
      return;
    }
    if (!isAdmin) {
      setError('Only admin can record');
      return;
    }
    
    const frameRate = 60;
    const frameInterval = 1000 / frameRate;
    const startTime = Date.now();
    
    recordingFrameNumberRef.current = 0;
    setIsRecording(true);
    const participantCount = experimentParticipantIdentitySetRef.current.size;
    const session: RecordingSession = {
      startTime,
      roomName,
      frames: [],
      frameRate,
      broadcastMessages: [],
      events: [],
      groupAssignments: { ...groupAssignmentsRef.current },
      experimentName,
      trialNumber,
      taskType: taskMode,
      displayMode,
      participantCount,
    };
    setRecordingSession(session);
    recordingSessionRef.current = session;
    setError(null);

    logAdminEvent({
      type: 'recordingStarted',
      timestamp: startTime,
    });
    
    if (recordingTickerStopRef.current) {
      recordingTickerStopRef.current();
      recordingTickerStopRef.current = null;
    }
    recordingTickerStopRef.current = createHighRateTicker(frameInterval, () => {
      captureFrameRef.current?.();
    });
  }, [connectionState, roomName, isAdmin, isSimMode, logAdminEvent, experimentName, trialNumber, taskMode, displayMode]);

  const uploadRecordingSession = useCallback(async (finalSession: RecordingSession) => {
    console.log('[Upload] Starting upload to Supabase tables...');
    console.log('[Upload] Experiment:', finalSession.experimentName || '(unnamed)');
    console.log('[Upload] Trial:', finalSession.trialNumber);
    console.log('[Upload] Frames:', finalSession.frames.length);
    console.log('[Upload] Events:', finalSession.events.length);
    console.log('[Upload] Broadcast messages:', finalSession.broadcastMessages.length);
    
    setIsUploading(true);
    setUploadProgress(0);
    
    try {
      const { data: existingRecording, error: existingRecordingError } = await supabase
        .from('recordings')
        .select('id')
        .eq('experiment_name', finalSession.experimentName.trim())
        .eq('trial_number', finalSession.trialNumber)
        .eq('start_time', finalSession.startTime)
        .maybeSingle();
      if (existingRecordingError) throw existingRecordingError;
      if (existingRecording) {
        console.log('[Upload] Recording already stored; treating retry as successful:', existingRecording.id);
        setUploadProgress(100);
        return;
      }

      // Step 1: Create the recording record
      setUploadProgress(10);
      const sessionGroups = finalSession.groupAssignments ?? { assignments: {}, groupCount: 1 };
      let recordingUsesLegacyJsonFallback = false;
      let { data: recordingData, error: recordingError } = await supabase
        .from('recordings')
        .insert({
          experiment_name: finalSession.experimentName.trim(),
          trial_number: finalSession.trialNumber,
          room_name: finalSession.roomName,
          start_time: finalSession.startTime,
          end_time: finalSession.endTime,
          frame_rate: finalSession.frameRate,
          total_frames: finalSession.frames.length,
          group_assignments: sessionGroups.assignments,
          group_count: sessionGroups.groupCount,
          // Recording context for filename composition (added 2026-05-06).
          task_type: finalSession.taskType,
          display_mode: finalSession.displayMode,
          participant_count: finalSession.participantCount,
          experiment_config: finalSession.experimentConfig ?? {},
          trial_metadata: finalSession.trialMetadata ?? {},
          session_json: finalSession,
        })
        .select()
        .single();

      if (recordingError && isMissingDatabaseColumnError(recordingError)) {
        console.warn('[Upload] Falling back to legacy recording schema:', recordingError.message);
        recordingUsesLegacyJsonFallback = true;
        const fallback = await supabase
          .from('recordings')
          .insert({
            experiment_name: finalSession.experimentName.trim(),
            trial_number: finalSession.trialNumber,
            room_name: finalSession.roomName,
            start_time: finalSession.startTime,
            end_time: finalSession.endTime,
            frame_rate: finalSession.frameRate,
            total_frames: finalSession.frames.length,
          })
          .select()
          .single();
        recordingData = fallback.data;
        recordingError = fallback.error;
      }

      if (recordingError) {
        console.error('[Upload] Recording insert error:', recordingError);
        setError(`Upload failed: ${recordingError.message}`);
        throw recordingError;
      }

      const recordingId = recordingData.id;
      console.log('[Upload] Recording created with ID:', recordingId);
      setUploadProgress(20);

      // Step 2: Insert frames in batches (to avoid payload size limits)
      const BATCH_SIZE = 100;
      const totalFrames = finalSession.frames.length;
      let framesInserted = 0;

      for (let i = 0; i < totalFrames; i += BATCH_SIZE) {
        const batch = finalSession.frames.slice(i, i + BATCH_SIZE).map(frame => ({
          recording_id: recordingId,
          frame_number: frame.frameNumber,
          timestamp: frame.timestamp,
          average_x: frame.average?.x ?? null,
          average_y: frame.average?.y ?? null,
          target_x: frame.target?.x ?? null,
          target_y: frame.target?.y ?? null,
          target_shape: frame.target?.shape ?? null,
          cursors: frame.cursors,
          participant_targets: frame.participantTargets ?? {},
          group_averages: frame.groupAverages ?? {},
        }));

        const { error: framesError } = await supabase
          .from('frames')
          .insert(batch);

        if (framesError) {
          if (isMissingDatabaseColumnError(framesError)) {
            console.warn('[Upload] Falling back to legacy frame schema at batch', i, ':', framesError.message);
            const legacyBatch = finalSession.frames.slice(i, i + BATCH_SIZE).map(frame => ({
              recording_id: recordingId,
              frame_number: frame.frameNumber,
              timestamp: frame.timestamp,
              average_x: frame.average?.x ?? null,
              average_y: frame.average?.y ?? null,
              target_x: frame.target?.x ?? null,
              target_y: frame.target?.y ?? null,
              target_shape: frame.target?.shape ?? null,
              cursors: frame.cursors,
            }));
            const { error: legacyFramesError } = await supabase
              .from('frames')
              .insert(legacyBatch);
            if (!legacyFramesError) {
              framesInserted += legacyBatch.length;
              const progress = 20 + Math.floor((framesInserted / totalFrames) * 60);
              setUploadProgress(progress);
              continue;
            }
            console.error('[Upload] Legacy frames insert error at batch', i, ':', legacyFramesError);
            setError(`Upload failed (frames): ${legacyFramesError.message}`);
            throw legacyFramesError;
          }
          console.error('[Upload] Frames insert error at batch', i, ':', framesError);
          setError(`Upload failed (frames): ${framesError.message}`);
          throw framesError;
        }

        framesInserted += batch.length;
        const progress = 20 + Math.floor((framesInserted / totalFrames) * 60);
        setUploadProgress(progress);
      }

      console.log('[Upload] All frames inserted:', framesInserted);
      setUploadProgress(85);

      // Step 3: Insert events
      {
        const eventsForUpload = recordingUsesLegacyJsonFallback
          ? [
              ...finalSession.events,
              {
                type: 'recordingSessionJson' as const,
                timestamp: finalSession.endTime ?? Date.now(),
                t: (finalSession.endTime ?? Date.now()) - finalSession.startTime,
                session: finalSession,
              },
            ]
          : finalSession.events;
        const eventsToInsert = eventsForUpload.map(event => {
          const { type, timestamp, t, ...eventData } = event;
          return {
            recording_id: recordingId,
            event_type: type,
            event_data: eventData,
            timestamp: timestamp,
            relative_time: t,
          };
        });

        if (eventsToInsert.length > 0) {
          const { error: eventsError } = await supabase
            .from('events')
            .insert(eventsToInsert);

          if (eventsError) {
            console.error('[Upload] Events insert error:', eventsError);
            setError(`Upload failed (events): ${eventsError.message}`);
            throw eventsError;
          }
        }
      }

      console.log('[Upload] Events inserted:', finalSession.events.length);
      setUploadProgress(95);

      // Step 4: Insert broadcast messages
      if (finalSession.broadcastMessages.length > 0) {
        const messagesToInsert = finalSession.broadcastMessages.map(msg => ({
          recording_id: recordingId,
          message_id: msg.id,
          text: msg.text,
          duration_ms: msg.durationMs ?? null,
          severity: msg.severity ?? 'info',
          position: msg.position ?? 'center',
          timestamp: msg.timestamp,
        }));

        const { error: messagesError } = await supabase
          .from('broadcast_messages')
          .insert(messagesToInsert);

        if (messagesError) {
          console.error('[Upload] Messages insert error:', messagesError);
          setError(`Upload failed (messages): ${messagesError.message}`);
          throw messagesError;
        }
      }

      console.log('[Upload] Broadcast messages inserted:', finalSession.broadcastMessages.length);
      console.log('[Upload] Upload complete!');
      
      setUploadProgress(100);
      setTimeout(() => {
        setUploadProgress(null);
      }, 2000);
    } catch (err) {
      console.error('[Upload] Exception:', err);
      setError(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setUploadProgress(null);
      throw err;
    } finally {
      setIsUploading(false);
    }
  }, []);

  const uploadRecordingSessionRef = useRef(uploadRecordingSession);
  useEffect(() => {
    uploadRecordingSessionRef.current = uploadRecordingSession;
  }, [uploadRecordingSession]);
  const recordingUploadQueueRef = useRef<SequentialUploadQueue<RecordingSession> | null>(null);
  if (!recordingUploadQueueRef.current) {
    recordingUploadQueueRef.current = new SequentialUploadQueue<RecordingSession>(
      (session) => uploadRecordingSessionRef.current(session),
      { maxAttempts: 5, retryDelayMs: 1500 },
    );
  }

  const stopRecording = useCallback(() => {
    if (!recordingSessionRef.current) return null;

    logAdminEvent({ type: 'recordingStopped', timestamp: Date.now() });
    if (recordingTickerStopRef.current) {
      recordingTickerStopRef.current();
      recordingTickerStopRef.current = null;
    }
    if (recordingIntervalRef.current !== null) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }

    const finalSession: RecordingSession = {
      ...recordingSessionRef.current,
      endTime: Date.now(),
    };
    setIsRecording(false);
    setRecordingSession(finalSession);
    recordingSessionRef.current = null;

    const uploadKey = `${finalSession.experimentName}:${finalSession.trialNumber}:${finalSession.startTime}`;
    if (!recordingUploadQueueRef.current) throw new Error('Recording upload queue is unavailable');
    const uploadPromise = recordingUploadQueueRef.current.enqueue(uploadKey, finalSession);
    return {
      experimentName: finalSession.experimentName,
      trialNumber: finalSession.trialNumber,
      uploadPromise,
    };
  }, [logAdminEvent]);

  // Ref to always access the LATEST stopRecording (avoids stale closure in room listener)
  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const downloadRecording = useCallback(() => {
    if (!recordingSession) {
      setError('No recording session available');
      return;
    }
    const data = JSON.stringify(recordingSession, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildRecordingFilename({
      startTime: recordingSession.startTime,
      taskType: recordingSession.taskType,
      participantCount: recordingSession.participantCount,
      trialNumber: recordingSession.trialNumber,
      displayMode: recordingSession.displayMode,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [recordingSession]);

  const clearRecording = useCallback(() => {
    setRecordingSession(null);
    setIsRecording(false);
  }, []);

  const getRecordingDataSize = useCallback((session: RecordingSession | null): string => {
    if (!session) return '0 B';
    
    const jsonString = JSON.stringify(session);
    const bytes = new Blob([jsonString]).size;
    
    if (bytes < 1024) {
      return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    } else {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
  }, []);

  const sendControlMessage = useCallback((message: ControlMessage) => {
    const room = roomRef.current;
    if (!room || !isAdmin) {
      return;
    }
    try {
      const payload = new TextEncoder().encode(JSON.stringify(message));
      room.localParticipant.publishData(payload, {
        reliable: true,
        topic: CONTROL_TOPIC,
      });
    } catch (err) {
      console.error('Failed to send control message', err);
    }
  }, [isAdmin]);

  const handleBroadcastMessage = useCallback((message: BroadcastMessage) => {
    if (!isAdmin && (message.waitForNext || (message.instructionPages?.length ?? 0) > 0)) {
      setParticipantExperimentFlowStarted(true);
      if (isCursorControlExperimentTask(experimentTaskType)) {
        setTask7AdminStartObserved(true);
      }
    }
    const id = `${message.timestamp}-${Math.random()}`;
    const messageWithId = { ...message, id };
    // Each on-screen slot (top / center / bottom) only has space for one
    // message — multiple at the same position render on top of each other.
    // When a new broadcast arrives, dismiss the existing one in that same
    // slot first. This lets the agent extend an instruction's broadcast
    // lifetime to span the following Yes/No phase (so the instruction stays
    // readable while Yes/No is shown), and have the next instruction cleanly
    // replace the previous one when the agent moves on. Recording captures
    // every broadcast independently in `recordingSession.broadcastMessages`,
    // so this client-side dedup doesn't affect saved data.
    setBroadcastMessages((prev) => {
      const slot = message.position ?? 'center';
      const filtered = prev.filter((m) => (m.position ?? 'center') !== slot);
      return [...filtered, messageWithId];
    });

    if (isRecording && recordingSession) {
      setRecordingSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          broadcastMessages: [...prev.broadcastMessages, messageWithId],
        };
      });
    }

    const duration = message.durationMs || 5000;
    setTimeout(() => {
      setBroadcastMessages((prev) => prev.filter((m) => m.id !== id));
    }, duration);
  }, [isAdmin, isRecording, recordingSession]);

  // Ref to always access the LATEST handleBroadcastMessage. The room
  // `DataReceived` listener is registered once at connect time and captures a
  // snapshot of the current handler — so its closure holds the values of
  // `isRecording` / `recordingSession` from that moment. Reading via this ref
  // ensures the listener uses the up-to-date version when broadcasts arrive
  // mid-recording. Mirrors the `stopRecordingRef` pattern used elsewhere.
  const handleBroadcastMessageRef = useRef(handleBroadcastMessage);
  useEffect(() => {
    handleBroadcastMessageRef.current = handleBroadcastMessage;
  }, [handleBroadcastMessage]);

  const sendBroadcastMessage = useCallback((text: string, durationMs: number = 5000, position: 'center' | 'bottom' = 'center') => {
    const room = roomRef.current;
    if (!room || !isAdmin || !text.trim()) {
      return;
    }
    try {
      const message: BroadcastMessage = {
        type: 'broadcast',
        text: text.trim(),
        durationMs,
        severity: 'info',
        position,
        timestamp: Date.now(),
      };
      const payload = new TextEncoder().encode(JSON.stringify(message));
      room.localParticipant.publishData(payload, {
        reliable: true,
        topic: BROADCAST_TOPIC,
      });
      setBroadcastText('');
      
      handleBroadcastMessage(message);
      
      logAdminEvent({
        type: 'broadcast',
        text: text.trim(),
        duration: durationMs,
        severity: 'info',
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('Failed to send broadcast message', err);
    }
  }, [isAdmin, handleBroadcastMessage, logAdminEvent]);

  const openTemplateWindow = useCallback(() => {
    if (typeof window === 'undefined') return;
    
    if (templateWindowRef.current && !templateWindowRef.current.closed) {
      templateWindowRef.current.focus();
      return;
    }

    const popup = window.open('', 'templateMessages', 'width=450,height=650,resizable=yes,scrollbars=yes');
    if (!popup) {
      setError('Please allow popups for this site to use template messages');
      return;
    }

    templateWindowRef.current = popup;
    const templatesJson = JSON.stringify(templateMessages);
    const origin = window.location.origin;

    popup.document.write(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Template Messages</title>
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            margin: 0;
            padding: 1rem;
            background: #f8fafc;
          }
          h1 {
            font-size: 1.25rem;
            margin: 0 0 0.5rem 0;
            color: #1f2937;
          }
          p {
            font-size: 0.875rem;
            color: #6b7280;
            margin: 0 0 1rem 0;
          }
          .templates {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          }
          button {
            padding: 0.75rem 1rem;
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 0.5rem;
            text-align: left;
            cursor: pointer;
            font-size: 0.875rem;
            color: #374151;
            transition: all 0.15s ease;
          }
          button:hover {
            background: #8b5cf6;
            color: white;
            border-color: #8b5cf6;
          }
          .index {
            font-weight: 500;
            margin-right: 0.5rem;
            opacity: 0.5;
          }
          .sent {
            background: #10b981 !important;
            color: white !important;
            border-color: #10b981 !important;
          }
        </style>
      </head>
      <body>
        <h1>Template Messages</h1>
        <p>Click a message to send it to all participants</p>
        <div class="templates" id="templates"></div>
        <script>
          const templates = ${templatesJson};
          const origin = ${JSON.stringify(origin)};
          
          function sendTemplate(text, btn) {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage({ type: 'broadcastTemplate', text: text }, origin);
              btn.classList.add('sent');
              setTimeout(() => btn.classList.remove('sent'), 500);
            } else {
              alert('Parent window was closed. Please reopen from the admin panel.');
            }
          }
          
          const container = document.getElementById('templates');
          templates.forEach((text, index) => {
            const btn = document.createElement('button');
            btn.innerHTML = '<span class="index">#' + (index + 1) + '</span>' + text;
            btn.onclick = function() { sendTemplate(text, this); };
            container.appendChild(btn);
          });
        </script>
      </body>
      </html>
    `);
    popup.document.close();
  }, [templateMessages]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (typeof window === 'undefined') return;
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'broadcastTemplate') return;

      const text = String(event.data.text || '');
      if (!text.trim()) return;
      sendBroadcastMessage(text, broadcastDuration);
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sendBroadcastMessage, broadcastDuration]);

  useEffect(() => {
    return () => {
      templateWindowRef.current?.close();
    };
  }, []);

    const handleControlMessage = useCallback((message: ControlMessage, participant: Participant | undefined) => {
      if (message.type === 'hello' && isAdminRef.current) {
        // Convert visuomotor rotation from internal radians to the wire
        // format (degrees) so the mid-join participant lands on the same
        // rotation as everyone else for an in-progress reaching trial.
        const cursorRotationDeg = cursorRotationRadRef.current * 180 / Math.PI;
        sendControlMessage({
          type: 'state',
          payload: {
            displayMode, hideCursor, targetVisible, useVirtualCursor, taskMode,
            experimentTaskType: isCursorControlExperimentTask(experimentTaskType) ? experimentTaskType : null,
            yesNoAreas, showClickAreaOverlay, guideTrackingRunning, joystickMultiplier,
            participantCursorSize, averageCursorSize, circleTargetSize, randomTargetSize,
            groupAssignments,
            task9SharedFeedbackEnabled,
            // Reaching task state (so mid-join participants render correctly
            // mid-trial without waiting for the next setCursorRotation /
            // setAvgCursorOffset re-broadcast at next trial start).
            cursorRotationDeg,
            avgCursorOffset: avgCursorOffsetRef.current,
            // Guide tracking radius (so mid-join participants see the guide
            // at the experiment-config size instead of their stale default).
            circleTargetRadius,
          },
        });
        return;
      }

      // Accept messages from admin participants OR from the server (participant undefined = RoomServiceClient.sendData)
      const senderIdentity = participant?.identity || '';
      const isFromServer = participant === undefined;
      if (!isFromServer && !senderIdentity.startsWith('admin:')) {
        return;
      }

      if (message.type === 'state') {
        setDisplayMode(message.payload.displayMode);
        setHideCursor(message.payload.hideCursor);
        if (message.payload.targetVisible !== undefined) {
          setTargetVisible(message.payload.targetVisible);
        }
        if (message.payload.useVirtualCursor !== undefined) {
          setUseVirtualCursor(message.payload.useVirtualCursor);
        }
        if (message.payload.taskMode !== undefined) {
          setTaskMode(message.payload.taskMode);
        }
        if (message.payload.experimentTaskType !== undefined) {
          setExperimentTaskType(message.payload.experimentTaskType);
        }
        if (message.payload.yesNoAreas !== undefined) {
          setYesNoAreas(message.payload.yesNoAreas);
        }
        if (message.payload.showClickAreaOverlay !== undefined) {
          setShowClickAreaOverlay(message.payload.showClickAreaOverlay);
        }
        if (message.payload.guideTrackingRunning !== undefined) {
          setGuideTrackingRunning(message.payload.guideTrackingRunning);
        }
        if (message.payload.joystickMultiplier !== undefined) {
          setJoystickMultiplier(message.payload.joystickMultiplier);
        }
        if (message.payload.participantCursorSize !== undefined) {
          setParticipantCursorSize(message.payload.participantCursorSize);
        }
        if (message.payload.averageCursorSize !== undefined) {
          setAverageCursorSize(message.payload.averageCursorSize);
        }
        if (message.payload.circleTargetSize !== undefined) {
          setCircleTargetSize(message.payload.circleTargetSize);
        }
        if (message.payload.randomTargetSize !== undefined) {
          setRandomTargetSize(message.payload.randomTargetSize);
        }
        if (message.payload.groupAssignments !== undefined) {
          setGroupAssignments(message.payload.groupAssignments);
        }
        // Reaching task: pick up the current rotation + offset for an
        // in-progress trial. Without these, a mid-join participant's
        // pointer-locked input would have rotation=0 and their displayed
        // average cursor would render at rawAvg (no offset) until the next
        // trial-start re-broadcast.
        if (typeof message.payload.cursorRotationDeg === 'number' && Number.isFinite(message.payload.cursorRotationDeg)) {
          cursorRotationRadRef.current = (message.payload.cursorRotationDeg * Math.PI) / 180;
        }
        if (message.payload.avgCursorOffset !== undefined) {
          avgCursorOffsetRef.current = message.payload.avgCursorOffset;
          setAvgCursorOffset(message.payload.avgCursorOffset);
        }
        // Guide tracking radius: pick up the admin's local value (which
        // reflects the agent's setGuideTrackingRunning broadcast or the
        // demo panel input). Without this, mid-join participants render
        // the guide at default 0.3 even after admin configured otherwise.
        if (typeof message.payload.circleTargetRadius === 'number' && Number.isFinite(message.payload.circleTargetRadius)) {
          setCircleTargetRadius(message.payload.circleTargetRadius);
        }
        if (message.payload.task9SharedFeedbackEnabled !== undefined) {
          setTask9SharedFeedbackEnabled(message.payload.task9SharedFeedbackEnabled);
        }
      } else if (message.type === 'setMode') {
        setDisplayMode(message.mode);
      } else if (message.type === 'setTask9SharedFeedback') {
        setTask9SharedFeedbackEnabled(message.enabled);
      } else if (message.type === 'setGroupAssignments') {
        setGroupAssignments({ assignments: message.assignments, groupCount: message.groupCount });
      } else if (message.type === 'setHideCursor') {
        setHideCursor(message.hideCursor);
      } else if (message.type === 'setTargetVisibility') {
        setTargetVisible(message.visible);
      } else if (message.type === 'setUseVirtualCursor') {
        setUseVirtualCursor(message.useVirtualCursor);
        if (!message.useVirtualCursor) {
          setTask7PointerLockRecoveryRequired(false);
        }
        // Auto-show click area overlay so participants can lock pointer
        if (message.useVirtualCursor && !isAdminRef.current) {
          setParticipantExperimentFlowStarted(true);
          setShowClickAreaOverlay(true);
        }
      } else if (message.type === 'task7PointerLockRecovery') {
        const identity = localIdentityRef.current;
        if (!isAdminRef.current && identity) {
          const needsOwnRecovery = message.identities.includes(identity);
          setTask7PointerLockRecoveryRequired(needsOwnRecovery);
          const serverUrl = tokenServerUrl.replace(/\/$/, '');
          fetch(`${serverUrl}/agent/virtual-cursor-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity, isPointerLocked: isPointerLockedRef.current }),
          }).catch(() => { /* pointerlockchange also retries for the recovering participant */ });
        }
      } else if (message.type === 'complete') {
        if (isAdminRef.current) {
          void finishAdminSession({
            disconnect: async () => {
              await disconnectRef.current?.();
            },
          });
        } else if (typeof window !== 'undefined') {
          suppressParticipantWithdrawReportRef.current = true;
          const completionUrl = message.url || COMPLETION_URL;
          const identity = localIdentityRef.current;
          const room = roomRef.current;
          const serverUrl = tokenServerUrl.replace(/\/$/, '');
          void finishParticipantSession({
            notifyServer: async () => {
              if (!identity) return;
              void fetch(`${serverUrl}/agent/participant-complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity }),
                keepalive: true,
              }).catch((error) => {
                console.warn('Failed to report participant completion:', error);
              });
            },
            disconnect: async () => {
              if (room) await room.disconnect();
            },
            navigate: (url) => { window.location.href = url; },
            completionUrl,
          });
        }
      } else if (message.type === 'participantTermination') {
        if (!isAdminRef.current) {
          suppressParticipantWithdrawReportRef.current = true;
          setParticipantTerminationOutcome({
            disposition: message.disposition,
            reason: message.reason,
            elapsedSeconds: message.elapsedSeconds,
          });
        }
      } else if (message.type === 'setYesNoAreas') {
        setYesNoAreas(message.yesNoAreas);
      } else if (message.type === 'setClickAreaOverlay') {
        setShowClickAreaOverlay(message.showClickAreaOverlay);
      } else if (message.type === 'unlockPointerLock') {
        if (document.pointerLockElement === stageRef.current) {
          document.exitPointerLock();
        }
        setIsPointerLocked(false);
        setTask7PointerLockRecoveryRequired(false);
        virtualCursorPosRef.current = { x: 0.5, y: 0.5 };
      } else if (message.type === 'resetVirtualCursorPosition') {
        virtualCursorPosRef.current = { x: 0.5, y: 0.5 };
        sendCursorRef.current?.(0.5, 0.5, true);
      } else if (message.type === 'setVirtualCursorPosition') {
        const x = typeof message.x === 'number' ? message.x : 0.5;
        const y = typeof message.y === 'number' ? message.y : 0.5;
        virtualCursorPosRef.current = { x, y };
        sendCursorRef.current?.(x, y, true);
      } else if (message.type === 'setCursorRotation') {
        const deg = typeof message.degrees === 'number' ? message.degrees : 0;
        cursorRotationRadRef.current = (deg * Math.PI) / 180;
      } else if (message.type === 'setAvgCursorOffset') {
        const x = typeof message.x === 'number' ? message.x : 0;
        const y = typeof message.y === 'number' ? message.y : 0;
        avgCursorOffsetRef.current = { x, y };
        setAvgCursorOffset({ x, y });
      } else if (message.type === 'kick') {
            if (!isAdminRef.current && message.targetIdentity === localIdentityRef.current) {
              setIsKicked(true);
            }
          } else if (message.type === 'setGuideTrackingRunning') {
            setGuideTrackingRunning(message.guideTrackingRunning);
            // When the agent passes a radius, propagate it into the local
            // state so the guide renders at the experiment-config size on
            // every client (admin and participants). Without this branch,
            // the agent's `config.circleTargetRadius` (set via AgentAdmin)
            // never reaches `p5StageGuide`, which falls back to admin's
            // local default state — a silent visual regression.
            if (typeof message.radius === 'number' && Number.isFinite(message.radius)) {
              setCircleTargetRadius(message.radius);
            }
          } else if (message.type === 'setJoystickMultiplier') {
            setJoystickMultiplier(message.multiplier);
          } else if (message.type === 'resetMobileCursorPosition') {
            mobileCursorPosRef.current = { x: 0.5, y: 0.5 };
            setMobileCursorPos({ x: 0.5, y: 0.5 });
            sendCursorRef.current?.(0.5, 0.5, true);
          } else if (message.type === 'setCursorSize') {
            setParticipantCursorSize(message.participantCursorSize);
            setAverageCursorSize(message.averageCursorSize);
          } else if (message.type === 'setTargetSize') {
            setCircleTargetSize(message.circleTargetSize);
            setRandomTargetSize(message.randomTargetSize);
          } else if (message.type === 'agentStartRecording') {
            setParticipantExperimentFlowStarted(true);
            // Track the active experiment-task type for *all* clients (admin
            // and participants) so the per-task sketch style block applies
            // even when taskMode is ambiguous (e.g. circle-target-tracking is
            // shared by both circle and group-circle tasks). Server-side
            // validation of message.taskType happens via ExperimentTaskType.
            if (message.taskType) {
              setExperimentTaskType(message.taskType as ExperimentTaskType);
            }
            // Only admin handles recording commands
            if (isAdminRef.current) {
              if (!shouldAcceptAgentRecordingCommand(message.sourceOrigin)) {
                console.log('[Agent Recording] Ignoring recording start from another origin:', message.sourceOrigin);
                return;
              }
              setExperimentName(message.experimentName);
              setTrialNumber(message.trialNumber);
              // Capture metadata from the agent message — fall back to current
              // client-side state when fields are missing (older agents).
              const recTaskType = message.taskType ?? taskModeRef.current ?? 'unknown';
              const recDisplayMode = (message.displayMode ?? displayMode ?? 'avgOnly') as DisplayMode;
              let recParticipantCount = message.participantCount;
              if (recParticipantCount === undefined) {
                recParticipantCount = experimentParticipantIdentitySetRef.current.size;
              }
              // Start recording after a short delay for state to settle
              setTimeout(() => {
                const frameRate = 60;
                const frameInterval = 1000 / frameRate;
                const startTime = Date.now();
                recordingFrameNumberRef.current = 0;
                sharedTrackingStartsRef.current.clear();
                const session: RecordingSession = {
                  startTime,
                  roomName,
                  frames: [],
                  frameRate,
                  broadcastMessages: [],
                  events: [],
                  groupAssignments: { ...groupAssignmentsRef.current },
                  experimentName: message.experimentName,
                  trialNumber: message.trialNumber,
                  taskType: recTaskType,
                  displayMode: recDisplayMode,
                  participantCount: recParticipantCount,
                  experimentConfig: message.experimentConfig,
                  trialMetadata: pendingTrialMetadataRef.current ?? undefined,
                };
                pendingTrialMetadataRef.current = null;
                // Install session ref FIRST so the very first tick can capture
                // (captureFrame reads recordingSessionRef.current synchronously).
                recordingSessionRef.current = session;
                setRecordingSession(session);
                setIsRecording(true);
                setError(null);
                // Stop any stale ticker from a previous trial before starting a new one.
                if (recordingTickerStopRef.current) {
                  recordingTickerStopRef.current();
                  recordingTickerStopRef.current = null;
                }
                recordingTickerStopRef.current = createHighRateTicker(frameInterval, () => {
                  captureFrameRef.current?.();
                });
                console.log(`[Agent Recording] Started: "${message.experimentName}" trial #${message.trialNumber}`);
                // Notify agent
                const serverUrl = tokenServerUrl.replace(/\/$/, '');
                void postRecordingStatusWithRetry(serverUrl, {
                  status: 'recording',
                  experimentName: message.experimentName,
                  trialNumber: message.trialNumber,
                }).catch((error) => console.error('[Agent Recording] Failed to report recording status:', error));
              }, 100);
            }
          } else if (message.type === 'setRecordingMetadata') {
            if (isAdminRef.current) {
              if (recordingSessionRef.current) {
                recordingSessionRef.current.trialMetadata = message.trialMetadata;
                setRecordingSession({ ...recordingSessionRef.current });
                pendingTrialMetadataRef.current = null;
              } else {
                pendingTrialMetadataRef.current = message.trialMetadata;
              }
            }
          } else if (message.type === 'agentStopRecording') {
            if (isAdminRef.current) {
              if (!shouldAcceptAgentRecordingCommand(message.sourceOrigin)) {
                console.log('[Agent Recording] Ignoring recording stop from another origin:', message.sourceOrigin);
                return;
              }
              console.log('[Agent Recording] Stopping via ref (avoids stale closure)...');
              // Use ref to get the LATEST stopRecording function
              // (room.on listener has stale closure; direct call would use old isRecording=false)
              const latestStopRecording = stopRecordingRef.current;
              if (latestStopRecording) {
                const stoppedRecording = latestStopRecording();
                if (!stoppedRecording) {
                  console.error('[Agent Recording] No active recording matched the stop command.');
                  return;
                }
                const serverUrl = tokenServerUrl.replace(/\/$/, '');
                void postRecordingStatusWithRetry(serverUrl, {
                  status: 'queued',
                  experimentName: stoppedRecording.experimentName,
                  trialNumber: stoppedRecording.trialNumber,
                }).catch((error) => console.error('[Agent Recording] Failed to report queued status:', error));
                stoppedRecording.uploadPromise.then(async () => {
                  console.log('[Agent Recording] Upload complete, notifying agent.');
                  setRecordingDatabaseRefreshKey((key) => key + 1);
                  await postRecordingStatusWithRetry(serverUrl, {
                    status: 'uploaded',
                    experimentName: stoppedRecording.experimentName,
                    trialNumber: stoppedRecording.trialNumber,
                  });
                }, async (err) => {
                  console.error('[Agent Recording] Upload failed:', err);
                  await postRecordingStatusWithRetry(serverUrl, {
                    status: 'error',
                    experimentName: stoppedRecording.experimentName,
                    trialNumber: stoppedRecording.trialNumber,
                  });
                }).catch((error) => {
                  console.error('[Agent Recording] Failed to report final upload status:', error);
                });
              }
            }
          } else if (message.type === 'agentStartCircleTarget') {
            if (isAdminRef.current) {
              // Full reset before starting to ensure clean state for every trial
              circleTargetStartTimeRef.current = null;
              setCircleTargetRunning(false);
              setCircleTargetTimerActive(false);
              setCircleTargetElapsedTime(0);
              // Set parameters
              setCircleTargetPeriod(message.period);
              setCircleTargetRadius(message.radius);
              setCircleTargetDuration(message.durationMs);
              // Start fresh after a microtask to allow state to settle
              setTimeout(() => {
                circleTargetStartTimeRef.current = Date.now();
                setCircleTargetRunning(true);
                setCircleTargetTimerActive(true);
                setTargetVisible(true);
                targetVisibleRef.current = true;
                sendControlMessage({
                  type: 'setTargetVisibility',
                  visible: true,
                  timestamp: Date.now(),
                });
                console.log(`[Agent] Circle target started: period=${message.period}, radius=${message.radius}, duration=${message.durationMs}ms`);
              }, 50);
            }
          } else if (message.type === 'agentStopCircleTarget') {
            if (isAdminRef.current) {
              circleTargetStartTimeRef.current = null;
              setCircleTargetRunning(false);
              setCircleTargetTimerActive(false);
              setCircleTargetElapsedTime(0);
              setTargetVisible(false);
              setTargetState({ x: 0.5 + circleTargetRadius, y: 0.5, shape: 'square' });
              sendControlMessage({
                type: 'setTargetVisibility',
                visible: false,
                timestamp: Date.now(),
              });
              console.log('[Agent] Circle target stopped');
            }
          } else if (message.type === 'startSketchTrajectory') {
            // ── Admin-side sketch trajectory loop ──────────────────────
            // Server agent's `publishSketchTrajectory(params, durationMs)`
            // brackets this. Admin's tab looks up the active sketch's
            // `trajectory.compute(elapsedMs, params)` and publishes each
            // non-null return on TARGET_TOPIC. Non-admin clients ignore.
            if (isAdminRef.current) {
              // Defensive: clear any leftover loop.
              if (sketchTrajectoryTimerRef.current !== null) {
                window.clearInterval(sketchTrajectoryTimerRef.current);
                sketchTrajectoryTimerRef.current = null;
              }
              const sketch = activeSketchRef.current;
              const trajectory = sketch?.trajectory;
              if (!trajectory) {
                console.warn('[Sketch Trajectory] No active sketch trajectory; ignoring start.');
                return;
              }
              const params = message.params ?? {};
              const intervalMs = (typeof trajectory.intervalMs === 'number' && trajectory.intervalMs > 0)
                ? trajectory.intervalMs
                : 50;
              const startTime = Date.now();
              const tick = () => {
                const elapsed = Date.now() - startTime;
                let output;
                try {
                  output = trajectory.compute(elapsed, params);
                } catch (err) {
                  console.error('[Sketch Trajectory] compute() threw:', err);
                  return;
                }
                if (!output) return;
                const room = roomRef.current;
                if (!room) return;
                try {
                  const payload = new TextEncoder().encode(JSON.stringify({
                    type: 'target',
                    x: output.x,
                    y: output.y,
                    shape: output.shape ?? 'square',
                    ...(output.color !== undefined ? { color: output.color } : {}),
                    trajectoryParams: params,
                    trajectoryElapsedMs: elapsed,
                    timestamp: Date.now(),
                  }));
                  room.localParticipant.publishData(payload, {
                    reliable: true,
                    topic: TARGET_TOPIC,
                  });
                } catch (err) {
                  console.error('[Sketch Trajectory] publish failed:', err);
                }
              };
              tick(); // Immediate first frame so participants don't wait intervalMs.
              sketchTrajectoryTimerRef.current = window.setInterval(tick, intervalMs);
              console.log(`[Sketch Trajectory] Started (sketch=${sketch?.id}, intervalMs=${intervalMs}).`);
            }
          } else if (message.type === 'stopSketchTrajectory') {
            if (isAdminRef.current) {
              if (sketchTrajectoryTimerRef.current !== null) {
                window.clearInterval(sketchTrajectoryTimerRef.current);
                sketchTrajectoryTimerRef.current = null;
              }
              console.log('[Sketch Trajectory] Stopped.');
            }
          } else if (message.type === 'startSketchHitDetector') {
            // ── Admin-side hit detection loop ─────────────────────────
            // Server agent's `startSketchHitDetector(params)` triggers
            // this. Admin's tab polls the active sketch's `hit.detect(ctx)`
            // and POSTs the configured event to /agent/sketch-event on
            // the first true firing.
            if (isAdminRef.current) {
              if (sketchHitTimerRef.current !== null) {
                window.clearInterval(sketchHitTimerRef.current);
                sketchHitTimerRef.current = null;
              }
              const sketch = activeSketchRef.current;
              const hit = sketch?.hit;
              if (!hit) {
                console.warn('[Sketch Hit] No active sketch hit detector; ignoring start.');
                return;
              }
              const params = message.params ?? {};
              const eventName = hit.eventName ?? 'hit';
              const intervalMs = (typeof hit.intervalMs === 'number' && hit.intervalMs > 0)
                ? hit.intervalMs
                : 50;
              const startTime = Date.now();
              const serverUrl = tokenServerUrl.replace(/\/$/, '');
              const tick = () => {
                const elapsed = Date.now() - startTime;
                const target = targetVisibleRef.current ? targetStateRef.current : null;
                const detectCtx = {
                  averageCursor: averageCursorRef.current,
                  rawAverageCursor: rawAverageCursorRef.current,
                  target: target
                    ? { x: target.x, y: target.y, shape: target.shape, size: 0, fill: target.color ?? '' }
                    : null,
                  groupAverages: groupAveragesRef.current,
                  params,
                  elapsedMs: elapsed,
                };
                let fired = false;
                try {
                  fired = !!hit.detect(detectCtx);
                } catch (err) {
                  console.error('[Sketch Hit] detect() threw:', err);
                  return;
                }
                if (!fired) return;
                // First fire wins — stop polling, POST to server.
                if (sketchHitTimerRef.current !== null) {
                  window.clearInterval(sketchHitTimerRef.current);
                  sketchHitTimerRef.current = null;
                }
                console.log(`[Sketch Hit] Fired '${eventName}' after ${elapsed}ms.`);
                fetch(`${serverUrl}/agent/sketch-event`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: eventName }),
                }).catch((err) => {
                  console.error('[Sketch Hit] POST /agent/sketch-event failed:', err);
                });
              };
              sketchHitTimerRef.current = window.setInterval(tick, intervalMs);
              console.log(`[Sketch Hit] Started (sketch=${sketch?.id}, event=${eventName}, intervalMs=${intervalMs}).`);
            }
          } else if (message.type === 'stopSketchHitDetector') {
            if (isAdminRef.current) {
              if (sketchHitTimerRef.current !== null) {
                window.clearInterval(sketchHitTimerRef.current);
                sketchHitTimerRef.current = null;
              }
              console.log('[Sketch Hit] Stopped.');
            }
          } else if (message.type === 'setSharedCursorControl') {
            setSharedCursorControl((prev) => ({
              enabled: message.enabled,
              phase: message.phase ?? prev.phase,
              matrix: Array.isArray(message.matrix) ? message.matrix : prev.matrix,
              visualGain: typeof message.visualGain === 'number' && Number.isFinite(message.visualGain) ? message.visualGain : prev.visualGain,
              disturbance: message.disturbance ?? null,
            }));
            setSharedDisturbanceStartedAt(null);
            if (message.enabled) {
              clearSharedCursorTransitionTimer();
              setTask7PointerLockRecoveryRequired(false);
              setSharedTrackingEscInterrupted(false);
              setSharedQuestionnaireWaiting(false);
              setSharedCursorVisualHidden(false);
              setSharedCursorNativeHidden(false);
            } else if (taskModeRef.current === 'shared-single-cursor') {
              clearSharedCursorTransitionTimer();
              activeSharedTrackingTrialKeyRef.current = null;
              setSharedTrackingEscInterrupted(false);
              setSharedCursorVisualHidden(true);
            }
          } else if (message.type === 'showSharedCursorQuestionnaire') {
            if (!isAdminRef.current && !isViewerMode) {
              clearSharedCursorTransitionTimer();
              const alreadyOnThisTrial = sharedQuestionnaire.trialNumber === message.trialNumber
                && (sharedQuestionnaire.visible || sharedQuestionnaire.submitted);
              setSharedQuestionnaireWaiting(sharedQuestionnaire.submitted && sharedQuestionnaire.trialNumber === message.trialNumber);
              setSharedCursorVisualHidden(true);
              setSharedCursorNativeHidden(sharedQuestionnaire.submitted && sharedQuestionnaire.trialNumber === message.trialNumber);
              if (alreadyOnThisTrial) {
                return;
              }
              const revealRequest = ++sharedQuestionnaireRevealRequestRef.current;
              void waitForPointerLockRelease(document).then(() => {
                if (sharedQuestionnaireRevealRequestRef.current !== revealRequest) return;
                setSharedQuestionnaire({
                  visible: true,
                  trialNumber: message.trialNumber,
                  kind: message.kind ?? 'legacy',
                  agency: null,
                  partnership: null,
                  contribution: null,
                  submitted: false,
                  submitting: false,
                });
              });
            }
          } else if (message.type === 'hideSharedCursorQuestionnaire') {
            sharedQuestionnaireRevealRequestRef.current += 1;
            setSharedQuestionnaire((prev) => ({ ...prev, visible: false }));
          }
        }, [displayMode, hideCursor, targetVisible, useVirtualCursor, taskMode, experimentTaskType, yesNoAreas, showClickAreaOverlay, guideTrackingRunning, joystickMultiplier, participantCursorSize, averageCursorSize, circleTargetSize, randomTargetSize, groupAssignments, task9SharedFeedbackEnabled, sendControlMessage, roomName, tokenServerUrl, circleTargetRadius, clearSharedCursorTransitionTimer, sharedQuestionnaire]);

  // Ref to always access the LATEST handleControlMessage. The room
  // `DataReceived` listener is registered once in `connect()` and captures the
  // version of `handleControlMessage` from that moment — when admin's
  // `isAdmin` was still false (initial useState value), `taskMode` was
  // 'manual-instruction', `displayMode` was 'all-without-avg', etc. As a
  // result, when a participant joins later (e.g. mid-wait-phase) and sends
  // `hello`, the stale listener:
  //   (a) hits the stale `sendControlMessage` whose `isAdmin=false` closure
  //       short-circuits the publish, so the `state` reply is never sent at
  //       all, AND
  //   (b) even if it were sent, its payload would carry the initial state
  //       values rather than the current wait-phase setup.
  // Routing through this ref means stale listener invocations dispatch into
  // the up-to-date callback, whose closure has the live `taskMode`,
  // `displayMode`, etc., and the live `sendControlMessage` (with isAdmin=true)
  // that actually publishes. Same `*Ref` pattern as `stopRecordingRef`.
  const handleControlMessageRef = useRef(handleControlMessage);
  useEffect(() => {
    handleControlMessageRef.current = handleControlMessage;
  }, [handleControlMessage]);

  const sendChatMessage = useCallback((text: string) => {
    const room = roomRef.current;
    if (!room || !text.trim() || isAdmin) {
      return;
    }
    try {
      const message: ChatMessage = {
        type: 'chat',
        from: room.localParticipant.identity,
        text: text.trim(),
        timestamp: Date.now(),
      };
      const payload = new TextEncoder().encode(JSON.stringify(message));
      room.localParticipant.publishData(payload, {
        reliable: true,
        topic: CHAT_TOPIC,
      });
      setChatInput('');
    } catch (err) {
      console.error('Failed to send chat message', err);
    }
  }, [isAdmin]);

  const submitSharedQuestionnaire = useCallback(async () => {
    const contributionQuestion = sharedQuestionnaire.kind === 'contribution';
    if (
      (contributionQuestion
        ? sharedQuestionnaire.contribution === null
        : sharedQuestionnaire.agency === null || sharedQuestionnaire.partnership === null)
      || sharedQuestionnaire.submitted
      || sharedQuestionnaire.submitting
    ) {
      return;
    }
    const identity = localIdentityRef.current;
    if (!identity) return;
    clearSharedCursorTransitionTimer();
    setSharedCursorVisualHidden(true);
    setSharedCursorNativeHidden(true);
    setSharedQuestionnaireWaiting(true);
    setSharedQuestionnaire((prev) => ({
      ...prev,
      submitted: true,
      submitting: true,
      visible: false,
    }));
    if (stageRef.current && document.pointerLockElement !== stageRef.current) {
      stageRef.current.requestPointerLock();
    }
    try {
      const serverUrl = tokenServerUrl.replace(/\/$/, '');
      const room = roomRef.current;
      const message: SharedCursorResponseMessage = {
        type: 'sharedCursorResponse',
        identity,
        trialNumber: sharedQuestionnaire.trialNumber,
        questionnaireKind: sharedQuestionnaire.kind,
        ...(contributionQuestion
          ? { contribution: sharedQuestionnaire.contribution ?? undefined }
          : {
              agency: sharedQuestionnaire.agency ?? undefined,
              partnership: sharedQuestionnaire.partnership ?? undefined,
            }),
        timestamp: Date.now(),
      };
      await deliverSharedContributionResponse(
        async () => {
          if (!room) return;
          const payload = new TextEncoder().encode(JSON.stringify(message));
          await room.localParticipant.publishData(payload, { reliable: true, topic: STATS_TOPIC });
        },
        async () => {
          const response = await fetch(`${serverUrl}/agent/shared-cursor-response`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              identity,
              trialNumber: sharedQuestionnaire.trialNumber,
              questionnaireKind: sharedQuestionnaire.kind,
              ...(contributionQuestion
                ? { contribution: sharedQuestionnaire.contribution }
                : {
                    agency: sharedQuestionnaire.agency,
                    partnership: sharedQuestionnaire.partnership,
                  }),
            }),
          });
          if (!response.ok) {
            throw new Error(`Response submit failed: ${response.status}`);
          }
        },
      );
      setSharedQuestionnaire((prev) => ({ ...prev, submitting: false }));
    } catch (err) {
      setSharedQuestionnaire((prev) => ({ ...prev, visible: true, submitted: false, submitting: false }));
      setError(err instanceof Error ? err.message : 'Failed to submit response');
    }
  }, [clearSharedCursorTransitionTimer, sharedQuestionnaire, tokenServerUrl]);

  useEffect(() => {
    const publishSharedTrackingLifecycle = (
      type: SharedTrackingLifecycleMessage['type'],
      trialKey: string,
    ) => {
      const identity = localIdentityRef.current;
      const room = roomRef.current;
      if (!identity || !room) return;
      const message: SharedTrackingLifecycleMessage = {
        type,
        identity,
        trialKey,
        timestamp: Date.now(),
      };
      room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify(message)),
        { reliable: true, topic: STATS_TOPIC },
      );
    };
    const handleSharedTrackingStart = (event: Event) => {
      if (isAdminRef.current || isViewerMode) return;
      const detail = (event as CustomEvent<{
        trialKey?: unknown;
        trialNumber?: unknown;
        questionnaireRequired?: unknown;
        showFirstTrialHitHint?: unknown;
        durationMs?: unknown;
      }>).detail;
      const trialKey = typeof detail?.trialKey === 'string' ? detail.trialKey : '';
      if (trialKey) {
        activeSharedTrackingTrialKeyRef.current = trialKey;
        sharedTrackingEscInterruptedRef.current = false;
        setSharedTrackingEscInterrupted(false);
        setSharedQuestionnaireWaiting(false);
        setSharedCursorVisualHidden(false);
        setSharedCursorNativeHidden(false);
        setSharedDisturbanceStartedAt(Date.now());
        publishSharedTrackingLifecycle('sharedTrackingStart', trialKey);
        const durationMs = typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs)
          ? Math.max(0, detail.durationMs)
          : 35000;
        const existingTimer = sharedTrackingCompletionTimersRef.current.get(trialKey);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }
        const timer = window.setTimeout(() => {
          sharedTrackingCompletionTimersRef.current.delete(trialKey);
          window.dispatchEvent(new CustomEvent('shared-tracking-complete', {
            detail: {
              trialKey,
              trialNumber: typeof detail.trialNumber === 'number' ? detail.trialNumber : 0,
              questionnaireRequired: detail.questionnaireRequired === true,
            },
          }));
        }, durationMs + 250);
        sharedTrackingCompletionTimersRef.current.set(trialKey, timer);
      }
      setBroadcastMessages((prev) => prev.filter(
        (message) => message.text !== 'Keep the cursor in the home position.',
      ));
      if (detail?.showFirstTrialHitHint === true) {
        const durationMs = typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs)
          ? detail.durationMs
          : 35000;
        handleBroadcastMessageRef.current({
          type: 'broadcast',
          text: 'Track the moving target as accurately as possible.\nThe target changes from green to red while the cursor is inside it.',
          durationMs,
          severity: 'info',
          position: 'top',
          timestamp: Date.now(),
        });
      }
    };
    const handleSharedTrackingComplete = (event: Event) => {
      if (isAdminRef.current || isViewerMode) return;
      const detail = (event as CustomEvent<{
        trialKey?: unknown;
        trialNumber?: unknown;
        questionnaireRequired?: unknown;
      }>).detail;
      const trialKey = typeof detail?.trialKey === 'string' ? detail.trialKey : '';
      const trialNumber = typeof detail?.trialNumber === 'number' && Number.isFinite(detail.trialNumber)
        ? Math.floor(detail.trialNumber)
        : 0;
      const identity = localIdentityRef.current;
      if (!trialKey || !identity) return;
      const isCurrentTrackingTrial = activeSharedTrackingTrialKeyRef.current === trialKey;
      const needsEscRecovery = isCurrentTrackingTrial
        && sharedTrackingEscInterruptedRef.current
        && document.pointerLockElement !== stageRef.current;
      if (isCurrentTrackingTrial) {
        activeSharedTrackingTrialKeyRef.current = null;
        sharedTrackingEscInterruptedRef.current = false;
        setSharedTrackingEscInterrupted(false);
      }
      const completionTimer = sharedTrackingCompletionTimersRef.current.get(trialKey);
      if (completionTimer !== undefined) {
        window.clearTimeout(completionTimer);
        sharedTrackingCompletionTimersRef.current.delete(trialKey);
      }
      if (isCurrentTrackingTrial) {
        clearSharedCursorTransitionTimer();
        setSharedCursorVisualHidden(true);
        setSharedCursorNativeHidden(false);
        if (needsEscRecovery) {
          setTask7PointerLockRecoveryRequired(true);
        }
      }
      if (isCurrentTrackingTrial && detail?.questionnaireRequired === true && trialNumber > 0) {
        if (document.pointerLockElement === stageRef.current) {
          try {
            document.exitPointerLock();
          } catch {
            // Ignore browser-specific pointer-lock exit failures.
          }
        }
        useVirtualCursorRef.current = false;
        setUseVirtualCursor(false);
        isPointerLockedRef.current = false;
        setIsPointerLocked(false);
        setSharedQuestionnaireWaiting(false);
        setSharedQuestionnaire((prev) => {
          if (prev.trialNumber === trialNumber && prev.submitted) return prev;
          return {
            visible: true,
            trialNumber,
            kind: experimentTaskType === 'cursor-control-20260706' ? 'contribution' : 'legacy',
            agency: null,
            partnership: null,
            contribution: null,
            submitted: false,
            submitting: false,
          };
        });
      }
      publishSharedTrackingLifecycle('sharedTrackingComplete', trialKey);
      const serverUrl = tokenServerUrl.replace(/\/$/, '');
      const reportComplete = async (attempt = 1): Promise<void> => {
        try {
          const response = await fetch(`${serverUrl}/agent/shared-tracking-complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity, trialKey }),
          });
          if (!response.ok) throw new Error(`shared-tracking-complete ${response.status}`);
        } catch (err) {
          if (attempt >= 5) {
            console.warn('Failed to report shared tracking completion after retries', err);
            return;
          }
          window.setTimeout(() => {
            reportComplete(attempt + 1).catch(() => { /* handled inside */ });
          }, 300 * attempt);
        }
      };
      reportComplete().catch(() => { /* handled inside */ });
    };
    window.addEventListener('shared-tracking-start', handleSharedTrackingStart);
    window.addEventListener('shared-tracking-complete', handleSharedTrackingComplete);
    return () => {
      window.removeEventListener('shared-tracking-start', handleSharedTrackingStart);
      window.removeEventListener('shared-tracking-complete', handleSharedTrackingComplete);
    };
  }, [clearSharedCursorTransitionTimer, experimentTaskType, isViewerMode, tokenServerUrl]);

  const handleChatMessage = useCallback((message: ChatMessage) => {
    if (!isAdminRef.current) {
      return;
    }
    const id = `${message.timestamp}-${message.from}-${Math.random()}`;
    setChatMessages((prev) => [...prev, { ...message, id }]);
  }, []);

  const logParticipantEvent = useCallback((identity: string, displayName: string, eventType: 'joined' | 'left') => {
    if (!isAdminRef.current) {
      return;
    }
    const event: ParticipantLogEvent = {
      id: `${Date.now()}-${identity}-${eventType}-${Math.random()}`,
      identity,
      displayName,
      eventType,
      timestamp: Date.now(),
    };
    setParticipantLog((prev) => [...prev, event]);
  }, []);

  const triggerSessionCompletion = useCallback(() => {
    if (!isAdmin) {
      return;
    }
    sendControlMessage({
      type: 'complete',
      url: COMPLETION_URL,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'sessionEnded',
      completionUrl: COMPLETION_URL,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const kickParticipant = useCallback(async (targetIdentity: string) => {
    if (!isAdmin) {
      return;
    }
    const baseUrl = tokenServerUrl.replace(/\/$/, '');
    try {
      sendControlMessage({
        type: 'kick',
        targetIdentity,
        timestamp: Date.now(),
      });
      const response = await fetch(`${baseUrl}/kick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          room: roomName,
          identity: targetIdentity,
          adminPassword: adminPassword,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to kick participant:', errorData);
      }
    } catch (err) {
      console.error('Failed to kick participant', err);
    }
  }, [isAdmin, tokenServerUrl, roomName, adminPassword, sendControlMessage]);

  const updateDisplayMode = useCallback((mode: DisplayMode) => {
    if (!isAdmin) {
      return;
    }
    setDisplayMode(mode);
    sendControlMessage({
      type: 'setMode',
      mode,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'displayModeChanged',
      mode,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const updateTask9SharedFeedback = useCallback((enabled: boolean) => {
    if (!isAdmin) return;
    setTask9SharedFeedbackEnabled(enabled);
    sendControlMessage({
      type: 'setTask9SharedFeedback',
      enabled,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  const updateHideCursor = useCallback((hide: boolean) => {
    if (!isAdmin) {
      return;
    }
    setHideCursor(hide);
    sendControlMessage({
      type: 'setHideCursor',
      hideCursor: hide,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'cursorVisibilityChanged',
      hideCursor: hide,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const updateTargetVisibility = useCallback((visible: boolean) => {
    if (!isAdmin) {
      return;
    }
    setTargetVisible(visible);
    sendControlMessage({
      type: 'setTargetVisibility',
      visible,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: visible ? 'targetShown' : 'targetHidden',
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const startCircleTarget = useCallback(() => {
    if (!isAdmin) {
      return;
    }
    circleTargetStartTimeRef.current = Date.now();
    setCircleTargetRunning(true);
    setCircleTargetTimerActive(true);
    setTargetVisible(true);
    sendControlMessage({
      type: 'setTargetVisibility',
      visible: true,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'targetShown',
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const resetCircleTarget = useCallback(() => {
    if (!isAdmin) {
      return;
    }
    circleTargetStartTimeRef.current = null;
    setCircleTargetRunning(false);
    setCircleTargetTimerActive(false);
    setCircleTargetElapsedTime(0);
    setTargetVisible(false);
    setTargetState({ x: 0.5 + circleTargetRadius, y: 0.5, shape: 'square' });
    sendControlMessage({
      type: 'setTargetVisibility',
      visible: false,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'targetHidden',
      timestamp: Date.now(),
    });
    }, [isAdmin, sendControlMessage, logAdminEvent, circleTargetRadius]);

    const startGuideTracking = useCallback(() => {
      if (!isAdmin) {
        return;
      }
      setGuideTrackingRunning(true);
      setGuideTrackingTimerActive(true);
      sendControlMessage({
        type: 'setGuideTrackingRunning',
        guideTrackingRunning: true,
        timestamp: Date.now(),
      });
    }, [isAdmin, sendControlMessage]);

    const resetGuideTracking = useCallback(() => {
      if (!isAdmin) {
        return;
      }
      setGuideTrackingRunning(false);
      setGuideTrackingTimerActive(false);
      setGuideTrackingElapsedTime(0);
      sendControlMessage({
        type: 'setGuideTrackingRunning',
        guideTrackingRunning: false,
        timestamp: Date.now(),
      });
    }, [isAdmin, sendControlMessage]);

  const startRandomTargetTracking = useCallback(() => {
    if (!isAdmin) return;
    const trajectory = generateRandomTargetTrajectory();
    randomTargetTrajectoryRef.current = trajectory;
    randomTargetStartTimeRef.current = Date.now();
    setRandomTargetRunning(true);
    setRandomTargetElapsedTime(0);
    setTargetVisible(true);
    targetVisibleRef.current = true;
    // Set initial position at center
    const initPos = evaluateRandomTargetPosition(trajectory, 0);
    const initState: TargetState = { x: initPos.x, y: initPos.y, shape: 'circle' };
    setTargetState(initState);
    targetStateRef.current = initState;
    sendControlMessage({
      type: 'setTargetVisibility',
      visible: true,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'targetShown',
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const resetRandomTargetTracking = useCallback(() => {
    if (!isAdmin) return;
    setRandomTargetRunning(false);
    setRandomTargetElapsedTime(0);
    randomTargetTrajectoryRef.current = null;
    randomTargetStartTimeRef.current = null;
    setTargetVisible(false);
    targetVisibleRef.current = false;
    sendControlMessage({
      type: 'setTargetVisibility',
      visible: false,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'targetHidden',
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const formatDemoDateTime = useCallback((date: Date): string => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }, []);

  const startDemo = useCallback(() => {
    if (!isAdmin || connectionState !== 'connected') return;
    const now = Date.now();
    demoStartTimeRef.current = now;
    setDemoRunning(true);
    setDemoElapsedSeconds(0);

    // Generate demo experiment name
    const demoName = `Demo-${formatDemoDateTime(new Date(now))}`;
    setExperimentName(demoName);

    const participantCount = experimentParticipantIdentitySetRef.current.size;
    // Start recording automatically
    const session: RecordingSession = {
      startTime: now,
      roomName: roomName,
      frames: [],
      frameRate: 60,
      broadcastMessages: [],
      events: [],
      experimentName: demoName,
      trialNumber,
      taskType: taskMode,
      displayMode,
      participantCount,
    };
    recordingSessionRef.current = session;
    setRecordingSession(session);
    setIsRecording(true);
    recordingFrameNumberRef.current = 0;
    adminEventsRef.current = [];

    logAdminEvent({ type: 'recordingStarted', timestamp: now });

    if (recordingTickerStopRef.current) {
      recordingTickerStopRef.current();
      recordingTickerStopRef.current = null;
    }
    recordingTickerStopRef.current = createHighRateTicker(1000 / 60, () => {
      captureFrameRef.current?.();
    });

    // Start task based on current taskMode
    if (taskMode === 'target-tracking') {
      setTargetVisible(true);
      sendControlMessage({
        type: 'setTargetVisibility',
        visible: true,
        timestamp: now,
      });
    } else if (taskMode === 'circle-target-tracking') {
      startCircleTarget();
    } else if (taskMode === 'guide-tracking') {
      startGuideTracking();
    } else if (taskMode === 'random-target-tracking') {
      startRandomTargetTracking();
    }

    // Start elapsed timer
    demoTimerRef.current = window.setInterval(() => {
      if (demoStartTimeRef.current) {
        const elapsed = Math.floor((Date.now() - demoStartTimeRef.current) / 1000);
        setDemoElapsedSeconds(elapsed);
        // Auto-stop demo after 60 seconds for random-target-tracking
        if (taskMode === 'random-target-tracking' && elapsed >= RANDOM_TARGET_DURATION_S) {
          stopDemoRef.current();
        }
      }
    }, 1000);
  }, [isAdmin, connectionState, roomName, taskMode, logAdminEvent, formatDemoDateTime, sendControlMessage, startCircleTarget, startGuideTracking, startRandomTargetTracking]);

  const stopDemo = useCallback(async () => {
    if (!isAdmin) return;
    setDemoRunning(false);

    // Stop timer
    if (demoTimerRef.current !== null) {
      window.clearInterval(demoTimerRef.current);
      demoTimerRef.current = null;
    }

    // Stop task based on current taskMode
    if (taskMode === 'target-tracking') {
      setTargetVisible(false);
      sendControlMessage({
        type: 'setTargetVisibility',
        visible: false,
        timestamp: Date.now(),
      });
    } else if (taskMode === 'circle-target-tracking') {
      resetCircleTarget();
    } else if (taskMode === 'guide-tracking') {
      resetGuideTracking();
    } else if (taskMode === 'random-target-tracking') {
      resetRandomTargetTracking();
    }

    // Stop recording and auto-upload
    await stopRecording();

    demoStartTimeRef.current = null;
    setDemoElapsedSeconds(0);
  }, [isAdmin, taskMode, sendControlMessage, resetCircleTarget, resetGuideTracking, resetRandomTargetTracking, stopRecording]);

  useEffect(() => {
    stopDemoRef.current = stopDemo;
  }, [stopDemo]);

  // Werewolf animation: initialize cursors when demo starts, animate positions, clean up when demo stops
  useEffect(() => {
    const isWerewolfTask = taskMode === 'circle-target-tracking' || taskMode === 'guide-tracking';
    if (!demoRunning || !werewolfEnabled || !isWerewolfTask) {
      // Clean up werewolf cursors when not active
      werewolfCursorsRef.current = [];
      if (werewolfAnimRef.current !== null) {
        cancelAnimationFrame(werewolfAnimRef.current);
        werewolfAnimRef.current = null;
      }
      bumpRender();
      return;
    }

    // Initialize werewolf cursors with random phases
    const wolves: WerewolfCursorState[] = [];
    for (let i = 0; i < werewolfCount; i++) {
      wolves.push({
        identity: `werewolf:${i}`,
        x: 0.5,
        y: 0.5,
        phase: Math.random() * 2 * Math.PI,
        noisePhaseX: Math.random() * 2 * Math.PI,
        noisePhaseY: Math.random() * 2 * Math.PI,
      });
    }
    werewolfCursorsRef.current = wolves;

    const startTime = Date.now();
    const WEREWOLF_PUBLISH_INTERVAL = 33; // ~30Hz
    const animate = () => {
      const now = Date.now();
      const elapsed = (now - startTime) / 1000;
      for (const wolf of werewolfCursorsRef.current) {
        const pos = computeWerewolfPosition(
          elapsed,
          wolf.phase,
          wolf.noisePhaseX,
          wolf.noisePhaseY,
          werewolfSpeed,
          werewolfNoise,
          werewolfRadius,
        );
        wolf.x = pos.x;
        wolf.y = pos.y;
      }
      // Publish werewolf positions to other participants via LiveKit (~30Hz throttle)
      if (now - werewolfPublishTimerRef.current >= WEREWOLF_PUBLISH_INTERVAL) {
        werewolfPublishTimerRef.current = now;
        const room = roomRef.current;
        if (room) {
          try {
            const cursorsData = werewolfCursorsRef.current.map((wolf) => ({
              identity: wolf.identity,
              x: wolf.x,
              y: wolf.y,
            }));
            const payload = new TextEncoder().encode(JSON.stringify({ type: 'werewolf', cursors: cursorsData }));
            room.localParticipant.publishData(payload, { reliable: false, topic: WEREWOLF_TOPIC });
          } catch (err) {
            console.error('Failed to publish werewolf cursors', err);
          }
        }
      }
      bumpRender();
      werewolfAnimRef.current = requestAnimationFrame(animate);
    };
    werewolfAnimRef.current = requestAnimationFrame(animate);

    // Send empty werewolf list when cleaning up so viewers clear their werewolf cursors
    return () => {
      if (werewolfAnimRef.current !== null) {
        cancelAnimationFrame(werewolfAnimRef.current);
        werewolfAnimRef.current = null;
      }
      werewolfCursorsRef.current = [];
      // Notify viewers to clear werewolf cursors
      const room = roomRef.current;
      if (room) {
        try {
          const payload = new TextEncoder().encode(JSON.stringify({ type: 'werewolf', cursors: [] }));
          room.localParticipant.publishData(payload, { reliable: true, topic: WEREWOLF_TOPIC });
        } catch (_err) { /* ignore */ }
      }
      bumpRender();
    };
  }, [demoRunning, werewolfEnabled, werewolfCount, werewolfSpeed, werewolfNoise, werewolfRadius, taskMode, bumpRender]);

    const updateUseVirtualCursor= useCallback((useVirtual: boolean) => {
    if (!isAdmin) {
      return;
    }
    setUseVirtualCursor(useVirtual);
    sendControlMessage({
      type: 'setUseVirtualCursor',
      useVirtualCursor: useVirtual,
      timestamp: Date.now(),
    });
    logAdminEvent({
      type: 'virtualCursorModeChanged',
      useVirtualCursor: useVirtual,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage, logAdminEvent]);

  const updateShowClickAreaOverlay = useCallback((show: boolean) => {
    if (!isAdmin) {
      return;
    }
    setShowClickAreaOverlay(show);
    sendControlMessage({
      type: 'setClickAreaOverlay',
      showClickAreaOverlay: show,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  const unlockParticipantPointerLock = useCallback(() => {
    if (!isAdmin) {
      return;
    }
    sendControlMessage({
      type: 'unlockPointerLock',
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  const resetVirtualCursorPosition = useCallback(() => {
    if (!isAdmin) {
      return;
    }
    sendControlMessage({
      type: 'resetVirtualCursorPosition',
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  const updateJoystickMultiplier = useCallback((multiplier: number) => {
    if (!isAdmin) {
      return;
    }
    setJoystickMultiplier(multiplier);
    sendControlMessage({
      type: 'setJoystickMultiplier',
      multiplier,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  const resetMobileCursorPosition = useCallback(() => {
    if (!isAdmin) {
      return;
    }
    sendControlMessage({
      type: 'resetMobileCursorPosition',
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  const updateCursorSize = useCallback((newParticipantSize: number, newAverageSize: number) => {
    if (!isAdmin) {
      return;
    }
    setParticipantCursorSize(newParticipantSize);
    setAverageCursorSize(newAverageSize);
    sendControlMessage({
      type: 'setCursorSize',
      participantCursorSize: newParticipantSize,
      averageCursorSize: newAverageSize,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  const updateTargetSize = useCallback((newCircleTargetSize: number, newRandomTargetSize: number) => {
    if (!isAdmin) {
      return;
    }
    setCircleTargetSize(newCircleTargetSize);
    setRandomTargetSize(newRandomTargetSize);
    sendControlMessage({
      type: 'setTargetSize',
      circleTargetSize: newCircleTargetSize,
      randomTargetSize: newRandomTargetSize,
      timestamp: Date.now(),
    });
  }, [isAdmin, sendControlMessage]);

  useEffect(() => {
    const handlePointerLockChange = () => {
      const isLocked = document.pointerLockElement === stageRef.current;
      setIsPointerLocked(isLocked);
      if (isLocked) {
        virtualCursorPosRef.current = { x: 0.5, y: 0.5 };
        setTask7PointerLockRecoveryRequired(false);
      } else if (shouldRequireImmediatePointerLockRecovery({
        experimentTaskType: experimentTaskTypeRef.current,
        taskMode: taskModeRef.current,
        phase: sharedCursorControlRef.current.phase,
        hasActiveTrackingTrial: activeSharedTrackingTrialKeyRef.current !== null,
        hasActivePointToPointTrial: experimentTaskTypeRef.current === 'task9'
          && sharedCursorControlRef.current.enabled
          && targetVisibleRef.current
          && targetStateRef.current.trajectoryParams?.task9PointToPoint === true,
        hasInterTrialPointToPointInterval: task9InterTrialPointerLockGuardRef.current,
        isAdmin: isAdminRef.current,
      })) {
        sharedTrackingEscInterruptedRef.current = true;
        setSharedTrackingEscInterrupted(true);
        // Esc recovery is local to the affected participant. Keep the trial
        // timer and target trajectory running for both participants while this
        // participant clicks back into pointer-lock mode.
        setTask7PointerLockRecoveryRequired(true);
        const identity = roomRef.current?.localParticipant?.identity;
        const pointToPointTrialKey = targetStateRef.current.trajectoryParams?.trialKey;
        const trialKey = activeSharedTrackingTrialKeyRef.current
          ?? (typeof pointToPointTrialKey === 'string' ? pointToPointTrialKey : null);
        const room = roomRef.current;
        if (identity && trialKey && room) {
          const message: EscPressedMessage = {
            type: 'escPressed',
            identity,
            trialKey,
            phase: sharedCursorControlRef.current.phase,
            cursorX: virtualCursorPosRef.current.x,
            cursorY: virtualCursorPosRef.current.y,
            timestamp: Date.now(),
          };
          room.localParticipant.publishData(
            new TextEncoder().encode(JSON.stringify(message)),
            { reliable: true, topic: STATS_TOPIC },
          );
        }
      }
      // Report pointer lock status to server for agent tracking
      if (!isAdmin && connectionState === 'connected') {
        const identity = roomRef.current?.localParticipant?.identity;
        if (identity) {
          const serverUrl = tokenServerUrl.replace(/\/$/, '');
          const reportPointerLock = (attempt = 1) => {
            fetch(`${serverUrl}/agent/virtual-cursor-report`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ identity, isPointerLocked: isLocked }),
            }).catch(() => {
              if (attempt >= 5) return;
              window.setTimeout(() => reportPointerLock(attempt + 1), 250 * attempt);
            });
          };
          reportPointerLock();
        }
      }
    };

    document.addEventListener('pointerlockchange', handlePointerLockChange);
    return () => {
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
    };
  }, [isAdmin, connectionState, tokenServerUrl]);

  // Reaching task: admin reports the *raw* avg cursor position to the server
  // at ~10 Hz. The agent stores its own avg-cursor offset and applies it
  // internally for reach detection (so reporting raw keeps the admin agnostic
  // of the offset paradigm). Only active for admin while reaching is set.
  useEffect(() => {
    if (!isAdmin || connectionState !== 'connected' || taskMode !== 'reaching') {
      return;
    }
    const REPORT_INTERVAL = 100;
    const serverUrl = tokenServerUrl.replace(/\/$/, '');
    const timer = window.setInterval(() => {
      const raw = rawAverageCursorRef.current;
      if (!raw) return;
      fetch(`${serverUrl}/agent/avg-cursor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: raw.x, y: raw.y }),
      }).catch(() => { /* ignore network errors */ });
    }, REPORT_INTERVAL);
    return () => {
      window.clearInterval(timer);
    };
  }, [isAdmin, connectionState, taskMode, tokenServerUrl]);

  // Task1 readiness: the admin relays the latest two participant cursor
  // positions so the server can detect genuine movement before starting.
  useEffect(() => {
    if (!isAdmin || connectionState !== 'connected' || !isCursorControlExperimentTask(experimentTaskType)) return;
    const serverUrl = tokenServerUrl.replace(/\/$/, '');
    const timer = window.setInterval(() => {
      const reports = Array.from(cursorsRef.current.values())
        .filter((cursor) => !cursor.isLocal && !cursor.identity.startsWith('admin:') && !isSyntheticParticipantIdentity(cursor.identity))
        .slice(0, 2)
        .map((cursor) => ({ identity: cursor.identity, x: cursor.x, y: cursor.y, timestamp: Date.now() }));
      if (reports.length === 0) return;
      fetch(`${serverUrl}/agent/cursor-readiness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports }),
      }).catch(() => { /* ignore readiness reporting errors */ });
    }, 100);
    return () => window.clearInterval(timer);
  }, [isAdmin, connectionState, experimentTaskType, tokenServerUrl]);

  const generateNonOverlappingPositions= useCallback(() => {
      const AREA_RADIUS = 0.08;
      const MIN_DISTANCE = AREA_RADIUS * 3;
      const MARGIN = 0.15;
    
      const generateRandomPosition = () => ({
        x: MARGIN + Math.random() * (1 - 2 * MARGIN),
        y: MARGIN + Math.random() * (1 - 2 * MARGIN),
      });
    
      const distance = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
        return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
      };
    
      let yesPos = generateRandomPosition();
      let noPos = generateRandomPosition();
    
      let attempts = 0;
      while (distance(yesPos, noPos) < MIN_DISTANCE && attempts < 100) {
        noPos = generateRandomPosition();
        attempts++;
      }
    
      if (distance(yesPos, noPos) < MIN_DISTANCE) {
        yesPos = { x: 0.25, y: 0.5 };
        noPos = { x: 0.75, y: 0.5 };
      }
    
      return { yesPosition: yesPos, noPosition: noPos };
    }, []);

    const showYesNoAreas = useCallback(() => {
      if (!isAdmin) {
        return;
      }
      const positions = generateNonOverlappingPositions();
      const newState: YesNoAreasState = {
        visible: true,
        ...positions,
      };
      setYesNoAreas(newState);
      sendControlMessage({
        type: 'setYesNoAreas',
        yesNoAreas: newState,
        timestamp: Date.now(),
      });
    }, [isAdmin, sendControlMessage, generateNonOverlappingPositions]);

    const hideYesNoAreas = useCallback(() => {
      if (!isAdmin) {
        return;
      }
      const newState: YesNoAreasState = {
        ...yesNoAreas,
        visible: false,
      };
      setYesNoAreas(newState);
      sendControlMessage({
        type: 'setYesNoAreas',
        yesNoAreas: newState,
        timestamp: Date.now(),
      });
    }, [isAdmin, yesNoAreas, sendControlMessage]);

    // Report cursor area status to server for agent Yes/No area detection
    useEffect(() => {
      if (isAdmin || isViewerMode || !yesNoAreas.visible || connectionState !== 'connected') {
        return;
      }

      const AREA_RADIUS = 0.08;
      const REPORT_INTERVAL_MS = 1000;

      const reportArea = () => {
        const identity = localIdentityRef.current;
        if (!identity) return;

        const lastSend = lastSendRef.current;
        if (!lastSend.initialized) return;

        const cx = lastSend.x;
        const cy = lastSend.y;

        const distYes = Math.sqrt(
          (cx - yesNoAreas.yesPosition.x) ** 2 + (cy - yesNoAreas.yesPosition.y) ** 2,
        );
        const distNo = Math.sqrt(
          (cx - yesNoAreas.noPosition.x) ** 2 + (cy - yesNoAreas.noPosition.y) ** 2,
        );

        let area: 'yes' | 'no' | null = null;
        if (distYes <= AREA_RADIUS) {
          area = 'yes';
        } else if (distNo <= AREA_RADIUS) {
          area = 'no';
        }

        const serverUrl = tokenServerUrl.replace(/\/$/, '');
        fetch(`${serverUrl}/agent/area-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity, area }),
        }).catch(() => {
          // ignore fetch errors for area reporting
        });
      };

      reportArea();
      const interval = window.setInterval(reportArea, REPORT_INTERVAL_MS);
      return () => window.clearInterval(interval);
    }, [yesNoAreas, connectionState, isAdmin, isViewerMode, tokenServerUrl]);

    const updateTaskMode = useCallback((mode: TaskMode, taskType?: ExperimentTaskType) => {
    if (!isAdmin) {
      return;
    }
    setTaskMode(mode);
    setExperimentTaskType(taskType ?? null);
    const room = roomRef.current;
    if (!room) {
      return;
    }
    try {
      const message: TaskControlMessage = {
        type: 'taskControl',
        taskMode: mode,
        taskType,
        timestamp: Date.now(),
      };
      const payload = new TextEncoder().encode(JSON.stringify(message));
      room.localParticipant.publishData(payload, { reliable: true, topic: CONTROL_TOPIC });
      logAdminEvent({
        type: 'taskModeChanged',
        taskMode: mode,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('Failed to send task control message', err);
    }
  }, [isAdmin, logAdminEvent]);

  const handleTaskControlMessage = useCallback((message: TaskControlMessage, participant: Participant | undefined) => {
    if (isAdminRef.current) {
      // Admin accepts taskControl only from server (agent), not from other admins
      const isFromServer = participant === undefined;
      if (!isFromServer) return;
    }
    setTaskMode(message.taskMode);
    setExperimentTaskType(message.taskType ?? null);
  }, []);

  useEffect(() => {
    if (taskMode !== 'target-tracking' || !isAdmin) {
      return;
    }

    const TARGET_UPDATE_INTERVAL = 2000;

    const updateTarget = () => {
      const targetX = 0.1 + Math.random() * 0.8;
      const targetY = 0.1 + Math.random() * 0.8;

      const newState: TargetState = { x: targetX, y: targetY, shape: 'triangle' };
      setTargetState(newState);
      targetStateRef.current = newState;

      const room = roomRef.current;
      if (room) {
        try {
          const message: TargetMessage = {
            type: 'target',
            x: targetX,
            y: targetY,
            shape: 'triangle',
            timestamp: Date.now(),
          };
          const payload = new TextEncoder().encode(JSON.stringify(message));
          room.localParticipant.publishData(payload, { reliable: false, topic: TARGET_TOPIC });
        } catch (err) {
          console.error('Failed to send target position', err);
        }
      }
    };

    updateTarget();
    
    const targetInterval = window.setInterval(updateTarget, TARGET_UPDATE_INTERVAL);

    return () => {
      window.clearInterval(targetInterval);
    };
  }, [taskMode, isAdmin]);

  useEffect(() => {
    if (taskMode !== 'circle-target-tracking' || !isAdmin || !circleTargetRunning) {
      return;
    }

    const UPDATE_INTERVAL = 50; // Update every 50ms for smooth animation
    const startTime = circleTargetStartTimeRef.current || Date.now();

    const updateCircleTarget = () => {
      const now = Date.now();
      const elapsed = now - startTime;
      
      // Check if duration has elapsed and auto-hide
      if (elapsed >= circleTargetDuration) {
        setCircleTargetRunning(false);
        setTargetVisible(false);
        targetVisibleRef.current = false;
        circleTargetStartTimeRef.current = null;
        sendControlMessage({
          type: 'setTargetVisibility',
          visible: false,
          timestamp: now,
        });
        logAdminEvent({
          type: 'targetHidden',
          timestamp: now,
        });
        return;
      }
      
      const angle = (elapsed / circleTargetPeriod) * 2 * Math.PI;
      
      const targetX = 0.5 + circleTargetRadius * Math.cos(angle);
      const targetY = 0.5 + circleTargetRadius * Math.sin(angle);

      const newCircleState: TargetState = { x: targetX, y: targetY, shape: 'square' };
      setTargetState(newCircleState);
      targetStateRef.current = newCircleState;

      const room = roomRef.current;
      if (room) {
        try {
          const message: TargetMessage = {
            type: 'target',
            x: targetX,
            y: targetY,
            shape: 'square',
            timestamp: now,
          };
          const payload = new TextEncoder().encode(JSON.stringify(message));
          room.localParticipant.publishData(payload, { reliable: false, topic: TARGET_TOPIC });
        } catch (err) {
          console.error('Failed to send target position', err);
        }
      }
    };

    updateCircleTarget();
    
    const targetInterval = window.setInterval(updateCircleTarget, UPDATE_INTERVAL);

    return () => {
      window.clearInterval(targetInterval);
    };
  }, [taskMode, isAdmin, circleTargetPeriod, circleTargetRadius, circleTargetRunning, circleTargetDuration, sendControlMessage, logAdminEvent]);

  useEffect(() => {
    if (!circleTargetTimerActive) {
      return;
    }

    const startTime = circleTargetStartTimeRef.current || Date.now();
    
    const updateElapsedTime = () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setCircleTargetElapsedTime(elapsed);
    };

    updateElapsedTime();
    const timerInterval = window.setInterval(updateElapsedTime, 1000);

    return () => {
      window.clearInterval(timerInterval);
    };
    }, [circleTargetTimerActive]);

    const guideTrackingStartTimeRef = useRef<number | null>(null);

    const GUIDE_TRACKING_DURATION_SECONDS = 30;

    useEffect(() => {
      if (!guideTrackingTimerActive) {
        return;
      }

      if (guideTrackingStartTimeRef.current === null) {
        guideTrackingStartTimeRef.current = Date.now();
      }
      const startTime = guideTrackingStartTimeRef.current;
    
      const updateElapsedTime = () => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        setGuideTrackingElapsedTime(elapsed);
        
        // Auto-hide circle after 30 seconds (timer continues until Reset)
        if (elapsed >= GUIDE_TRACKING_DURATION_SECONDS) {
          setGuideTrackingRunning(false);
        }
      };

      updateElapsedTime();
      const timerInterval = window.setInterval(updateElapsedTime, 1000);

      return () => {
        window.clearInterval(timerInterval);
      };
    }, [guideTrackingTimerActive]);

    useEffect(() => {
      if (!guideTrackingTimerActive) {
        guideTrackingStartTimeRef.current = null;
      }
    }, [guideTrackingTimerActive]);

  // Random target tracking animation loop
  useEffect(() => {
    if (taskMode !== 'random-target-tracking' || !isAdmin || !randomTargetRunning) {
      return;
    }

    const trajectory = randomTargetTrajectoryRef.current;
    const startTime = randomTargetStartTimeRef.current;
    if (!trajectory || !startTime) return;

    const UPDATE_INTERVAL = 50; // 50ms = 20 FPS for smooth animation

    const updateRandomTarget = () => {
      const now = Date.now();
      const elapsedS = (now - startTime) / 1000;

      // Update elapsed time display
      setRandomTargetElapsedTime(Math.floor(elapsedS));

      // Auto-stop after duration
      if (elapsedS >= RANDOM_TARGET_DURATION_S) {
        setRandomTargetRunning(false);
        return;
      }

      const pos = evaluateRandomTargetPosition(trajectory, elapsedS);
      const newState: TargetState = { x: pos.x, y: pos.y, shape: 'circle' };
      setTargetState(newState);
      targetStateRef.current = newState;

      // Publish to participants via TARGET_TOPIC
      const room = roomRef.current;
      if (room) {
        try {
          const message: TargetMessage = {
            type: 'target',
            x: pos.x,
            y: pos.y,
            shape: 'circle',
            timestamp: now,
          };
          const payload = new TextEncoder().encode(JSON.stringify(message));
          room.localParticipant.publishData(payload, { reliable: false, topic: TARGET_TOPIC });
        } catch (err) {
          console.error('Failed to send random target position', err);
        }
      }
    };

    updateRandomTarget();
    const targetInterval = window.setInterval(updateRandomTarget, UPDATE_INTERVAL);

    return () => {
      window.clearInterval(targetInterval);
    };
  }, [taskMode, isAdmin, randomTargetRunning]);

    useEffect(() => {
      if (!isSimMode) return;
    
    setConnectionState('connected');
    
    const updateSimulatedCursors = () => {
      const t = Date.now() / 1000;
      
      // Participant 1: circular motion
      const x1 = 0.5 + 0.3 * Math.cos(t);
      const y1 = 0.5 + 0.3 * Math.sin(t);
      upsertCursor('sim-participant-1', {
        x: x1,
        y: y1,
        displayName: 'Participant 1',
        isLocal: false,
      });
      
      // Participant 2: figure-8 motion
      const x2 = 0.5 + 0.25 * Math.sin(t * 2);
      const y2 = 0.5 + 0.2 * Math.sin(t);
      upsertCursor('sim-participant-2', {
        x: x2,
        y: y2,
        displayName: 'Participant 2',
        isLocal: false,
      });
    };
    
    const simInterval = window.setInterval(updateSimulatedCursors, 100);
    updateSimulatedCursors(); // Initial update
    
    return () => {
      window.clearInterval(simInterval);
    };
  }, [isSimMode, upsertCursor]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [identity, cursor] of cursorsRef.current.entries()) {
        if (now - cursor.updatedAt > STALE_CURSOR_MS) {
          cursorsRef.current.delete(identity);
          changed = true;
        }
      }
      if (changed) {
        bumpRender();
      }
    }, 100);

    return () => window.clearInterval(interval);
  }, [bumpRender]);

  // (moved) dummy publish effect is defined after sendCursor

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  const handleDataReceived = useCallback((payload: Uint8Array, participant: Participant | undefined, _kind?: DataPacket_Kind, topic?: string) => {
    if (topic === CURSOR_TOPIC) {
      const decoded = decodeCursorPayload(payload);
      if (!decoded) {
        return;
      }
      const identity = participant?.identity ?? `hash-${decoded.hash.toString(16)}`;
      const displayName = participant?.name || identity;
      // Don't clamp cursor positions - allow values outside [0, 1] for virtual cursor mode
      const isLocal = participant?.isLocal ?? false;
      
      upsertCursor(identity, {
        x: decoded.x,
        y: decoded.y,
        updatedAt: Date.now(),
        displayName,
        color: colorFromIdentity(identity),
        isLocal,
        hash: decoded.hash,
      });
    } else if (topic === CONTROL_TOPIC) {
      try {
        const text = new TextDecoder().decode(payload);
        const message = JSON.parse(text);
        if (message.type === 'taskControl') {
          handleTaskControlMessage(message as TaskControlMessage, participant);
        } else {
          // Route through the ref so stale listener invocations still dispatch
          // into the current handler with up-to-date state in its closure
          // (critical for the admin's `hello` -> `state` reply, which carries
          // wait-phase setup like `taskMode='target-tracking'` to participants
          // who join after the agent's initial setup messages were broadcast).
          handleControlMessageRef.current(message as ControlMessage, participant);
        }
      } catch (err) {
        console.error('Failed to parse control message', err);
      }
    } else if (topic === BROADCAST_TOPIC) {
      try {
        const text = new TextDecoder().decode(payload);
        const message = JSON.parse(text) as BroadcastMessage;
        // Same ref-routing rationale as the CONTROL_TOPIC branch above:
        // ensures broadcasts received after recording state changes still hit
        // the latest handler (which sees the current `isRecording` /
        // `recordingSession`) and get persisted into the active recording.
        handleBroadcastMessageRef.current(message);
      } catch (err) {
        console.error('Failed to parse broadcast message', err);
      }
    } else if (topic === CHAT_TOPIC) {
      try {
        const text = new TextDecoder().decode(payload);
        const message = JSON.parse(text) as ChatMessage;
        handleChatMessage(message);
      } catch (err) {
        console.error('Failed to parse chat message', err);
      }
        } else if (topic === STATS_TOPIC) {
          try {
            const text = new TextDecoder().decode(payload);
            const message = JSON.parse(text) as StatsMessage | SharedCursorResponseMessage | SharedTrackingLifecycleMessage | EscPressedMessage;
            if (message.type === 'stats' && message.identity) {
              setLatencyByIdentity((prev) => {
                const next = new Map(prev);
                if (message.rttMs !== null) {
                  next.set(message.identity, message.rttMs);
                } else {
                  next.delete(message.identity);
                }
                return next;
              });
              setParticipantStatusByIdentity((prev) => {
                const next = new Map(prev);
                next.set(message.identity, {
                  isPointerLocked: message.isPointerLocked ?? false,
                  isUsingVirtualCursor: message.isUsingVirtualCursor ?? false,
                });
                return next;
              });
            } else if (message.type === 'sharedCursorResponse' && isAdminRef.current) {
              logAdminEvent({
                type: 'sharedCursorResponse',
                identity: message.identity,
                trialNumber: message.trialNumber,
                questionnaireKind: message.questionnaireKind,
                agency: message.agency,
                partnership: message.partnership,
                contribution: message.contribution,
                timestamp: message.timestamp,
              });
            } else if (
              (message.type === 'sharedTrackingStart' || message.type === 'sharedTrackingComplete')
              && isAdminRef.current
            ) {
              if (message.type === 'sharedTrackingStart') {
                sharedTrackingStartsRef.current.set(message.identity, {
                  trialKey: message.trialKey,
                  receivedAt: Date.now(),
                });
              }
              logAdminEvent({
                type: message.type,
                identity: message.identity,
                trialKey: message.trialKey,
                participantTimestamp: message.timestamp,
                timestamp: Date.now(),
              });
            } else if (message.type === 'escPressed' && isAdminRef.current) {
              logAdminEvent({
                type: 'escPressed',
                identity: message.identity,
                trialKey: message.trialKey,
                phase: message.phase,
                cursorX: message.cursorX,
                cursorY: message.cursorY,
                participantTimestamp: message.timestamp,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            console.error('Failed to parse stats message', err);
          }
        }else if (topic === TARGET_TOPIC) {
      try {
        const text = new TextDecoder().decode(payload);
        const message = JSON.parse(text) as TargetMessage;
        if (message.type === 'target') {
          // Accept target from server (agent) for everyone including admin.
          // Only ignore target messages from other admin participants.
          const isFromServer = participant === undefined;
          if (!isAdminRef.current || isFromServer) {
            setTargetState({
              x: message.x,
              y: message.y,
              shape: message.shape,
              color: message.color,
              trajectoryParams: message.trajectoryParams,
              trajectoryElapsedMs: message.trajectoryElapsedMs,
              trajectoryReceivedAt: Date.now(),
            });
          }
        }
      } catch (err) {
        console.error('Failed to parse target message', err);
      }
    } else if (topic === WEREWOLF_TOPIC) {
      try {
        const text = new TextDecoder().decode(payload);
        const message = JSON.parse(text) as { type: 'werewolf'; cursors: Array<{ identity: string; x: number; y: number }> };
        if (message.type === 'werewolf' && !isAdminRef.current) {
          receivedWerewolfCursorsRef.current = message.cursors;
          bumpRender();
        }
      } catch (err) {
        console.error('Failed to parse werewolf message', err);
      }
    }
  // Note: handleControlMessage and handleBroadcastMessage are intentionally
  // NOT in the dep list — they're routed through their `*Ref` ref to avoid
  // re-creating handleDataReceived (and incidentally re-registering the room
  // listener) every time their closures change.
  }, [upsertCursor, handleChatMessage, handleTaskControlMessage, bumpRender, logAdminEvent]);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    if (!room) {
      return;
    }
    
    if (recordingTickerStopRef.current) {
      recordingTickerStopRef.current();
      recordingTickerStopRef.current = null;
    }
    if (recordingIntervalRef.current !== null) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }

    room.removeAllListeners();
    await room.disconnect();
    roomRef.current = null;
    setConnectionState('disconnected');
    lastSendRef.current = { time: 0, x: 0, y: 0, initialized: false };
    resetCursors();
    setLiveKitParticipants(new Map());
  }, [resetCursors]);

  useEffect(() => {
    disconnectRef.current = disconnect;
    return () => {
      if (disconnectRef.current === disconnect) {
        disconnectRef.current = null;
      }
    };
  }, [disconnect]);

  const connect = useCallback(async () => {
    if (connectionState !== 'disconnected') {
      return;
    }
    const baseUrl = tokenServerUrl.replace(/\/$/, '');
    const url = new URL(`${baseUrl}/token`);
    url.searchParams.set('room', roomName);
    if (typeof window !== 'undefined' && window.location.hostname) {
      url.searchParams.set('publicHost', window.location.hostname);
    }
    if (identityInput.trim().length > 0) {
      url.searchParams.set('identity', identityInput.trim());
    }
    if (isParticipantPage) {
      url.searchParams.set('role', 'experiment-participant');
    }
    if (adminPassword.trim().length > 0) {
      url.searchParams.set('adminPassword', adminPassword.trim());
    }
    setConnectionState('connecting');
    setError(null);

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Token endpoint returned ${response.status}`);
      }
      const payload = (await response.json()) as TokenResponse;
      setIsAdmin(payload.isAdmin || false);
      
      ensureMediaDevicesEventTargetCompat();
      const room = new Room();
      roomRef.current = room;

      room.on(RoomEvent.DataReceived, handleDataReceived);
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        if (participant.identity) {
          const displayName = participant.name || participant.identity;
          logParticipantEvent(participant.identity, displayName, 'joined');
          setLiveKitParticipants(prev => {
            const next = new Map(prev);
            next.set(participant.identity, {
              identity: participant.identity,
              displayName,
              joinedAt: Date.now(),
              metadata: participant.metadata,
            });
            return next;
          });
        }
      });
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.identity) {
          const displayName = participant.name || participant.identity;
          logParticipantEvent(participant.identity, displayName, 'left');
          removeCursor(participant.identity);
          setLiveKitParticipants(prev => {
            const next = new Map(prev);
            next.delete(participant.identity);
            return next;
          });
        }
      });
      room.on(RoomEvent.ParticipantMetadataChanged, (metadata, participant) => {
        if (!participant.identity) return;
        setLiveKitParticipants(prev => {
          const next = new Map(prev);
          const existing = next.get(participant.identity);
          next.set(participant.identity, {
            identity: participant.identity,
            displayName: participant.name || participant.identity,
            joinedAt: existing?.joinedAt ?? Date.now(),
            metadata,
          });
          return next;
        });
      });
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (state === 'disconnected') {
          setConnectionState('disconnected');
          resetCursors();
        }
      });

      await room.connect(payload.url, payload.token);

      setConnectionState('connected');
      const identity = room.localParticipant?.identity ?? payload.identity;
      localIdentityRef.current = identity;
      const displayName = room.localParticipant?.name || identity;
      upsertCursor(identity, {
        x: 0.5,
        y: 0.5,
        displayName,
        color: colorFromIdentity(identity),
        isLocal: true,
      });

      setLiveKitParticipants(prev => {
        const next = new Map(prev);
        next.set(identity, {
          identity,
          displayName,
          joinedAt: Date.now(),
          metadata: room.localParticipant?.metadata,
        });
        return next;
      });

      if (isParticipantPage && prolificStudyId && prolificSubmissionId) {
        await fetch(`${baseUrl}/agent/prolific-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identity,
            studyId: prolificStudyId,
            submissionId: prolificSubmissionId,
          }),
        });
      }

      room.remoteParticipants.forEach((participant) => {
        if (participant.identity) {
          const pDisplayName = participant.name || participant.identity;
          setLiveKitParticipants(prev => {
            const next = new Map(prev);
            next.set(participant.identity, {
              identity: participant.identity,
              displayName: pDisplayName,
              joinedAt: Date.now(),
              metadata: participant.metadata,
            });
            return next;
          });
        }
      });

      if (!payload.isAdmin) {
        setTimeout(() => {
          try {
            const helloMessage: ControlMessage = { type: 'hello', version: 1 };
            const helloPayload = new TextEncoder().encode(JSON.stringify(helloMessage));
            room.localParticipant.publishData(helloPayload, {
              reliable: true,
              topic: CONTROL_TOPIC,
            });
          } catch (err) {
            console.error('Failed to send hello message', err);
          }
        }, 500);
      }
    } catch (err) {
      console.error(err);
      await disconnect();
      setConnectionState('disconnected');
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  }, [connectionState, tokenServerUrl, roomName, identityInput, adminPassword, isParticipantPage, prolificStudyId, prolificSubmissionId, handleDataReceived, removeCursor, disconnect, resetCursors, upsertCursor, logParticipantEvent]);

  useEffect(() => {
    // Skip auto-connect for mobile mode - it has its own useEffect that handles connection
    if (isMobileMode) {
      return;
    }
    if (hasConsented && !isAdmin && !isSimMode && !participantTerminationOutcome && connectionState === 'disconnected') {
      connect();
    }
  }, [hasConsented, isAdmin, isSimMode, participantTerminationOutcome, connectionState, connect, isMobileMode]);

  const reportParticipantWithdraw = useCallback((reason: string) => {
    if (!isParticipantPage) return;
    if (!participantExperimentFlowStartedRef.current) return;
    if (suppressParticipantWithdrawReportRef.current) return;
    if (participantWithdrawReportedRef.current) return;
    const identity = localIdentityRef.current || identityInput.trim();
    if (!identity) return;

    participantWithdrawReportedRef.current = true;
    const serverUrl = tokenServerUrl.replace(/\/$/, '');
    const payload = JSON.stringify({ identity, reason });
    const blob = new Blob([payload], { type: 'application/json' });
    const endpoint = `${serverUrl}/agent/participant-withdraw`;

    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, blob)) {
      return;
    }
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  }, [identityInput, isParticipantPage, tokenServerUrl]);

  useEffect(() => {
    if (!isParticipantPage) return;

    const handleBeforeUnload = () => reportParticipantWithdraw('browser unload');
    const handlePageHide = () => reportParticipantWithdraw('page hide');
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [isParticipantPage, reportParticipantWithdraw]);

  // Consent-screen deadline. Skips for non-participants
  // (admin/viewer/mobile/sim) — they share the latency-check skip set. Skips
  // the moment the participant clicks "I Agree and Continue" (hasConsented
  // flips to true). Updates a visible 1Hz countdown until it hits 0, then sets
  // participationCancelled which triggers the withdrawal screen render.
  useEffect(() => {
    if (skipLatencyCheck) return;
    if (hasConsented) return;
    if (participationCancelled) return;
    const deadline = Date.now() + CONSENT_DEADLINE_SECONDS * 1000;
    const tick = () => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        setConsentSecondsRemaining(0);
        setParticipationCancelledReason('deadline');
        setParticipationCancelled(true);
      } else {
        setConsentSecondsRemaining(Math.ceil(remainingMs / 1000));
      }
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [skipLatencyCheck, hasConsented, participationCancelled]);

  useEffect(() => {
    if (connectionState !== 'connected') {
      setLocalRttMs(null);
      return;
    }

    const pollRtt = async () => {
      const room = roomRef.current;
      if (!room) {
        return;
      }

      try {
        const rttMs = await getRttMs(room);
        setLocalRttMs(rttMs);

        if (rttMs !== null) {
          const identity = room.localParticipant?.identity;
          if (identity) {
                        const statsMessage: StatsMessage = {
                          type: 'stats',
                          identity,
                          rttMs,
                          isPointerLocked: isPointerLockedRef.current,
                          isUsingVirtualCursor: useVirtualCursorRef.current,
                          timestamp: Date.now(),
                        };
            const payload = new TextEncoder().encode(JSON.stringify(statsMessage));
            room.localParticipant.publishData(payload, {
              reliable: true,
              topic: STATS_TOPIC,
            });
          }
        }
      } catch (err) {
        console.warn('Failed to poll RTT', err);
      }
    };

    pollRtt();
    const interval = window.setInterval(pollRtt, STATS_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [connectionState]);

  const sendCursor = useCallback((x: number, y: number, forceSend = false) => {
    const room = roomRef.current;
    if (!room) {
      return;
    }
    
    if (isAdmin || isViewerMode) {
      return;
    }
    
    const now = performance.now();
    const last = lastSendRef.current;
    if (last.initialized && !forceSend) {
      // Time-based throttle to prevent excessive network traffic
      if (now - last.time < SEND_INTERVAL_MS) {
        return;
      }
      const deltaX = Math.abs(last.x - x);
      const deltaY = Math.abs(last.y - y);
      if (deltaX < DEAD_BAND && deltaY < DEAD_BAND) {
        return;
      }
    }

    const identity = room.localParticipant.identity;
    if (!identity) {
      return;
    }

    try {
      const payload = encodeCursorPayload(identity, x, y);
      room.localParticipant.publishData(payload, {
        reliable: false,
        topic: CURSOR_TOPIC,
      });
      lastSendRef.current = { time: now, x, y, initialized: true };
      const displayName = room.localParticipant.name || identity;
      upsertCursor(identity, {
        x,
        y,
        displayName,
        color: colorFromIdentity(identity),
        isLocal: true,
      });
    } catch (err) {
      console.error('Failed to publish cursor data', err);
    }
  }, [upsertCursor, isAdmin, isViewerMode]);

  useEffect(() => {
    sendCursorRef.current = sendCursor;
  }, [sendCursor]);

  // Debug: dummy single cursor replacing local mouse, publish via LiveKit
  useEffect(() => {
    if (!dummyEnabled || connectionState !== 'connected') {
      if (dummyParamsRef.current?.raf != null) {
        cancelAnimationFrame(dummyParamsRef.current.raf);
      }
      dummyParamsRef.current = null;
      return;
    }

    const a = 1 + Math.floor(Math.random() * 5);
    const b = 1 + Math.floor(Math.random() * 5);
    const phase = Math.random() * Math.PI * 2;
    const Ax = 0.35 + Math.random() * 0.1;
    const Ay = 0.35 + Math.random() * 0.1;
    const speed = 0.4 + Math.random() * 0.8;
    const params = { start: performance.now(), a, b, phase, Ax, Ay, speed, raf: null as number | null };
    dummyParamsRef.current = params;

    const step = () => {
      if (!dummyParamsRef.current) return;
      const now = performance.now();
      const t = ((now - params.start) / 1000) * params.speed;
      const x = 0.5 + params.Ax * Math.sin(params.a * t + params.phase);
      const y = 0.5 + params.Ay * Math.sin(params.b * t);
      sendCursor(clamp(x, 0, 1), clamp(y, 0, 1));
      params.raf = requestAnimationFrame(step);
    };
    params.raf = requestAnimationFrame(step);

    return () => {
      if (params.raf != null) cancelAnimationFrame(params.raf);
      dummyParamsRef.current = null;
    };
  }, [dummyEnabled, connectionState, sendCursor]);

  useEffect(() => {
    if (isAdmin || isViewerMode || connectionState !== 'connected' || dummyEnabled) {
      return;
    }

    const interval = window.setInterval(() => {
      const last = lastSendRef.current;
      if (last.initialized) {
        sendCursor(last.x, last.y, true);
      }
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [isAdmin, isViewerMode, connectionState, dummyEnabled, sendCursor]);

  useEffect(() => {
    if (isAdmin || connectionState !== 'connected' || taskMode === 'manual-instruction') {
      setIsInactive(false);
      return;
    }

    const interval = window.setInterval(() => {
      const timeSinceLastMovement = Date.now() - lastMovementTimeRef.current;
      const shouldBeInactive = timeSinceLastMovement >= 10000;
      
      if (shouldBeInactive !== isInactive) {
        setIsInactive(shouldBeInactive);
      }
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [isAdmin, connectionState, taskMode, isInactive]);

  useEffect(() => {
    if (!isParticipantPage || isAdmin || connectionState !== 'connected') return;
    const inactivityTimeoutEnabled = isCursorControlExperimentTask(experimentTaskType)
      ? task7AdminStartObserved
      : participantExperimentFlowStarted;
    if (!inactivityTimeoutEnabled) return;

    lastMovementTimeRef.current = Date.now();
    const interval = window.setInterval(() => {
      const timeSinceLastMovement = Date.now() - lastMovementTimeRef.current;
      if (timeSinceLastMovement >= PARTICIPANT_INACTIVITY_TIMEOUT_MS) {
        reportParticipantWithdraw('participant inactivity timeout');
        window.clearInterval(interval);
      }
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    connectionState,
    isAdmin,
    experimentTaskType,
    isParticipantPage,
    participantExperimentFlowStarted,
    reportParticipantWithdraw,
    task7AdminStartObserved,
  ]);

  // Panel resize handlers
  const handleResizeStart = useCallback((side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = side;
    resizeStartXRef.current = e.clientX;
    resizeStartWidthRef.current = side === 'left' ? leftPanelWidth : rightPanelWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [leftPanelWidth, rightPanelWidth]);

  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = e.clientX - resizeStartXRef.current;
      const newWidth = resizingRef.current === 'left'
        ? resizeStartWidthRef.current + delta
        : resizeStartWidthRef.current - delta;
      const clamped = Math.max(200, Math.min(600, newWidth));
      if (resizingRef.current === 'left') {
        setLeftPanelWidth(clamped);
      } else {
        setRightPanelWidth(clamped);
      }
    };
    const handleResizeEnd = () => {
      if (!resizingRef.current) return;
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
  }, []);

  const handlePointerEvent = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (connectionState !== 'connected') {
      return;
    }
    if (dummyEnabled) {
      return;
    }
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    
    let normX: number;
    let normY: number;
    
    if (isPointerLocked) {
      // Apply cursor gain FIRST (multiplier on raw normalized delta), then
      // visuomotor rotation. Gain = 1.0 → identity (no scaling). Order
      // matters: rotation of a scaled vector preserves the angle, only the
      // magnitude scales, which matches the intuition that gain affects
      // cursor speed while rotation affects direction.
      const gain = cursorGainRef.current;
      const dxNorm = (event.movementX / rect.width) * gain;
      const dyNorm = (event.movementY / rect.height) * gain;
      // Apply visuomotor rotation to the input delta. When the angle is 0
      // (default) cos=1, sin=0, so this reduces to the identity transform.
      const rotRad = cursorRotationRadRef.current;
      const dxRot = rotRad === 0 ? dxNorm : dxNorm * Math.cos(rotRad) - dyNorm * Math.sin(rotRad);
      const dyRot = rotRad === 0 ? dyNorm : dxNorm * Math.sin(rotRad) + dyNorm * Math.cos(rotRad);
      const prev = virtualCursorPosRef.current;
      normX = prev.x + dxRot;
      normY = prev.y + dyRot;
      virtualCursorPosRef.current = { x: normX, y: normY };
    } else {
      // Don't clamp - allow cursor to move outside [0, 1] stage boundary
      normX = (event.clientX - rect.left) / rect.width;
      normY = (event.clientY - rect.top) / rect.height;
    }
    
    sendCursor(normX, normY);
    
    lastMovementTimeRef.current = Date.now();
    if (isInactive) {
      setIsInactive(false);
    }
  }, [connectionState, sendCursor, dummyEnabled, isInactive, isPointerLocked]);

  // Track cursor position even when mouse leaves the stage area
  useEffect(() => {
    if (isAdmin || isViewerMode || connectionState !== 'connected' || dummyEnabled || isPointerLocked) {
      return;
    }

    const handleWindowPointerMove = (event: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      // Only track when mouse is outside the stage (stage's own handler covers inside)
      if (event.target === stage || stage.contains(event.target as Node)) return;

      const rect = stage.getBoundingClientRect();
      const normX = (event.clientX - rect.left) / rect.width;
      const normY = (event.clientY - rect.top) / rect.height;

      if (sendCursorRef.current) {
        sendCursorRef.current(normX, normY);
      }

      lastMovementTimeRef.current = Date.now();
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
    };
  }, [isAdmin, isViewerMode, connectionState, dummyEnabled, isPointerLocked]);

  const handlePointerLeave = useCallback(() => {
    // No longer show warning - cursor tracking continues outside stage
  }, []);

  const handlePointerEnterStage = useCallback(() => {
    setIsMouseOutsideStage(false);
  }, []);

  const disconnectButtonVisible = connectionState === 'connected';
  const connectButtonDisabled = connectionState !== 'disconnected';

  const isCursorControlTask = isCursorControlExperimentTask(experimentTaskType);
  const showLegacyInitialWorkspaceHint = !isAdmin
    && connectionState === 'connected'
    && taskMode === 'manual-instruction'
    && !isCursorControlTask
    && !yesNoAreas.visible
    && !sharedQuestionnaire.visible
    && !sharedQuestionnaireWaiting
    && !showClickAreaOverlay
    && !broadcastMessages.some((message) => message.position === 'bottom');
  const hasActivePagedInstruction = broadcastMessages.some(
    (message) => message.waitForNext && (message.instructionPages?.length ?? 0) > 0,
  );
  const showTask7WaitingPreview = shouldShowCursorControlWaitingPreview({
    connected: connectionState === 'connected',
    isCursorControlTask,
    participantExperimentFlowStarted,
    hasActivePagedInstruction,
    useVirtualCursor,
    yesNoVisible: yesNoAreas.visible,
    questionnaireVisible: sharedQuestionnaire.visible,
    questionnaireWaiting: sharedQuestionnaireWaiting,
    clickAreaOverlayVisible: showClickAreaOverlay,
    hasBottomBroadcast: broadcastMessages.some((message) => message.position === 'bottom'),
  });
  const showTask7InitialWorkspaceHint = !isAdmin && showTask7WaitingPreview;
  const showInitialWorkspaceHint = showLegacyInitialWorkspaceHint || showTask7InitialWorkspaceHint;
  const [task7WaitSecondsRemaining, setTask7WaitSecondsRemaining] = useState<number | null>(null);
  const task7WaitDeadlineRef = useRef<number | null>(null);
  useEffect(() => {
    if (!showTask7WaitingPreview || realParticipantConnectionCount >= 2) {
      task7WaitDeadlineRef.current = null;
      setTask7WaitSecondsRemaining(null);
      return;
    }
    if (task7WaitDeadlineRef.current === null) {
      task7WaitDeadlineRef.current = Date.now() + 5 * 60 * 1000;
    }
    const update = () => {
      const deadline = task7WaitDeadlineRef.current;
      if (deadline === null) return;
      setTask7WaitSecondsRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [showTask7WaitingPreview, realParticipantConnectionCount]);
  useEffect(() => {
    if (shouldResetParticipantStartConfirmation(realParticipantConnectionCount)) {
      setParticipantStartClicked(false);
      setParticipantStartRequestPending(false);
      setParticipantStartError(null);
    }
  }, [realParticipantConnectionCount]);

  const handleParticipantStartClick = useCallback(async () => {
    if (participantStartClicked || participantStartRequestPending) return;
    const identity = localIdentityRef.current;
    if (!identity) return;
    setParticipantStartRequestPending(true);
    setError(null);
    setParticipantStartError(null);
    try {
      await submitParticipantStart(fetch, tokenServerUrl, identity);
      setParticipantStartClicked(true);
    } catch (startError) {
      setParticipantStartClicked(false);
      setParticipantStartError(
        startError instanceof Error ? startError.message : 'Could not confirm START. Please try again.',
      );
    } finally {
      setParticipantStartRequestPending(false);
    }
  }, [participantStartClicked, participantStartRequestPending, tokenServerUrl]);
  const shouldHideNativeCursorOnStage = !isAdmin
    && connectionState === 'connected'
    && !isMouseOutsideStage
    && (
      showTask7InitialWorkspaceHint
      || (!hasActivePagedInstruction && (hideCursor || isPointerLocked || sharedCursorNativeHidden))
    );

  const visibleCursors = useMemo(() => {
    if (sharedCursorVisualHidden && taskMode === 'shared-single-cursor' && !isAdmin) {
      return [];
    }
    const experimentCursors = experimentParticipantIdentitySet.size > 0
      ? cursorList.filter((cursor) => experimentParticipantIdentitySet.has(cursor.identity))
      : cursorList.filter((cursor) => !cursor.identity.startsWith('admin:') && !isSyntheticParticipantIdentity(cursor.identity));
    if (isAdmin) {
      return experimentCursors.filter((cursor) => !cursor.isLocal);
    }
    if (showTask7InitialWorkspaceHint) {
      return experimentCursors;
    }
    
    if (displayMode === 'avgOnly') {
      return [];
    } else if (displayMode === 'self' || displayMode === 'self-with-avg') {
      return cursorList.filter((cursor) => cursor.isLocal);
    } else if (displayMode === 'all-without-avg' || displayMode === 'all-with-avg-lines' || displayMode === 'all-with-avg-no-lines') {
      return experimentCursors;
    } else {
      return experimentCursors;
    }
  }, [displayMode, cursorList, isAdmin, sharedCursorVisualHidden, taskMode, experimentParticipantIdentitySet, showTask7InitialWorkspaceHint]);

  const showAverageCursor = useMemo(() => {
    if (sharedCursorVisualHidden && taskMode === 'shared-single-cursor' && !isAdmin) {
      return false;
    }
    if (displayedAverageCursor === null) {
      return false;
    }
    if (isAdmin) {
      return true;
    }
    return displayMode === 'avgOnly' || displayMode === 'all-with-avg-lines' || displayMode === 'all-with-avg-no-lines' || displayMode === 'self-with-avg';
  }, [isAdmin, displayMode, displayedAverageCursor, sharedCursorVisualHidden, taskMode]);

  const shouldShowLabels = isAdmin || isViewerMode;

  // ───────────────────────────────────────────────────────────────────────
  // TaskStage data — derived state for the main stage's p5.js renderer.
  // Each useMemo produces one of the prop arrays/objects consumed by
  // <TaskStage>. ViewerMode and ReplayModal compute their own equivalents
  // since their cursor sources, labels, and viewports differ.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Active per-task sketch resolved from the current `experimentTaskType`
   * (preferred when known) or falling back to `taskMode`. The sketch's
   * optional `style` block is the **source of truth** for visual params
   * (cursor diameter, target shape/fill/size, etc.); each `p5StageXxx`
   * memo below consults this before falling back to legacy app state.
   *
   * The server agent remains in full control of *when* things happen — it
   * still sends `setMode`, `setTaskMode`, `setTargetVisibility`, target
   * positions, etc. The sketch only describes *how* those things look.
   */
  const activeSketch = useMemo(() => {
    return getSketchByExperimentTask(experimentTaskType)
      ?? getSketchByTaskMode(taskMode);
  }, [experimentTaskType, taskMode]);
  const sketchStyle = activeSketch?.style;

  // Sync activeSketchRef (declared earlier near other refs) so the room
  // listener can read the live sketch without a stale closure.
  useEffect(() => { activeSketchRef.current = activeSketch; }, [activeSketch]);

  // Sync cursor gain ref from the active sketch's inputs.cursorGain. The
  // ref pattern (rather than direct state) keeps `handlePointerEvent`
  // closure-stable; the pointer event handler reads `.current` each call.
  useEffect(() => {
    const gain = activeSketch?.inputs?.cursorGain;
    cursorGainRef.current = (typeof gain === 'number' && Number.isFinite(gain) && gain > 0)
      ? gain
      : 1;
  }, [activeSketch]);

  // Clean up any running sketch loops on unmount to prevent leaks if the
  // admin tab navigates away mid-trajectory or mid-hit-detection.
  useEffect(() => {
    return () => {
      if (sketchTrajectoryTimerRef.current !== null) {
        window.clearInterval(sketchTrajectoryTimerRef.current);
        sketchTrajectoryTimerRef.current = null;
      }
      if (sketchHitTimerRef.current !== null) {
        window.clearInterval(sketchHitTimerRef.current);
        sketchHitTimerRef.current = null;
      }
    };
  }, []);

  const task9SharedFeedbackCursors = useMemo(() => {
    if (
      experimentTaskType !== 'task9'
      || taskMode !== 'shared-single-cursor'
      || !shouldShowTask9SharedFeedback(task9SharedFeedbackEnabled, sharedCursorControl.enabled, sharedCursorControl.phase)
      || (sharedCursorVisualHidden && !isAdmin)
    ) {
      return [];
    }
    const participants = experimentParticipantIdentitySet.size > 0
      ? cursorList.filter((cursor) => experimentParticipantIdentitySet.has(cursor.identity))
      : cursorList.filter((cursor) => !cursor.identity.startsWith('admin:') && !isSyntheticParticipantIdentity(cursor.identity));
    return participants
      .sort((a, b) => a.identity.localeCompare(b.identity))
      .slice(0, 2);
  }, [
    cursorList,
    experimentParticipantIdentitySet,
    experimentTaskType,
    isAdmin,
    renderVersion,
    sharedCursorControl.enabled,
    sharedCursorControl.phase,
    sharedCursorVisualHidden,
    taskMode,
    task9SharedFeedbackEnabled,
  ]);

  const task9CompletionMessageVisible = broadcastMessages.some((message) => (
    message.position === 'bottom' && isTask9CompletionMessage(message.text)
  ));
  useEffect(() => {
    task9InterTrialPointerLockGuardRef.current = experimentTaskType === 'task9'
      && taskMode === 'shared-single-cursor'
      && task9CompletionMessageVisible
      && !sharedQuestionnaire.visible;
  }, [
    experimentTaskType,
    sharedQuestionnaire.visible,
    task9CompletionMessageVisible,
    taskMode,
  ]);
  const showTask9QuestionnaireScore = experimentTaskType === 'task9'
    && task9Score !== null
    && sharedQuestionnaire.kind === 'contribution'
    && shouldShowTask9QuestionnaireScore(
      task9Score.phase,
      task9Score.trialNumber,
      sharedQuestionnaire.trialNumber,
      sharedQuestionnaire.visible,
    );
  const showTask9CompletionScore = experimentTaskType === 'task9'
    && task9Score !== null
    && shouldShowTask9CompletionScore(task9Score.phase, task9CompletionMessageVisible);

  const p5StageCursors = useMemo<P5Dot[]>(() => {
    // sketch.style.cursor wins over app-state default. This lets a sketch
    // file fully describe the cursor look without app-state changes.
    const showTask9SharedFeedback = task9SharedFeedbackCursors.length >= 2;
    const cursorDiameter = showTask9SharedFeedback ? 8 : (sketchStyle?.cursor?.diameter ?? participantCursorSize);
    const cursorFill = sketchStyle?.cursor?.fill;
    const cursorOpacity = showTask9SharedFeedback ? 0.85 : sketchStyle?.cursor?.opacity;
    const task9FeedbackFill = (identity: string, fallbackIndex: number) => {
      if (!showTask9SharedFeedback) return null;
      if (!isAdmin) {
        return identity === localIdentityRef.current ? '#2563eb' : '#f97316';
      }
      return fallbackIndex === 0 ? '#2563eb' : '#f97316';
    };
    const result: P5Dot[] = [];
    for (const cursor of visibleCursors) {
      const cursorIndex = cursorList.findIndex((c) => c.identity === cursor.identity) + 1;
      const task9FeedbackIndex = task9SharedFeedbackCursors.findIndex((c) => c.identity === cursor.identity);
      const rttMs = latencyByIdentity.get(cursor.identity);
      let label: P5Dot['label'];
      if (shouldShowLabels) {
        label = {
          text: isAdmin ? `#${cursorIndex}` : cursor.displayName,
          color: 'rgba(30, 41, 59, 0.6)',
        };
        if (rttMs !== undefined && rttMs !== null) {
          label.extra = `${rttMs}ms`;
          label.extraColor = rttMs < 50 ? '#10b981' : rttMs < 150 ? '#f59e0b' : '#dc2626';
        }
      }
      result.push({
        id: cursor.identity,
        ...(shouldRotateTask8SharedDisplay
          ? rotatePointCounterClockwise90AroundCenter(cursor)
          : { x: cursor.x, y: cursor.y }),
        diameter: cursorDiameter,
        fill: task9FeedbackFill(cursor.identity, task9FeedbackIndex) ?? cursorFill ?? cursor.color,
        opacity: cursorOpacity,
        label,
      });
    }
    const visibleIdentitySet = new Set(visibleCursors.map((cursor) => cursor.identity));
    for (const [index, cursor] of task9SharedFeedbackCursors.entries()) {
      if (visibleIdentitySet.has(cursor.identity)) continue;
      result.push({
        id: `task9-feedback-${cursor.identity}`,
        x: cursor.x,
        y: cursor.y,
        diameter: cursorDiameter,
        fill: task9FeedbackFill(cursor.identity, index) ?? cursor.color,
        stroke: '#ffffff',
        strokeWidth: 1,
        opacity: cursorOpacity,
      });
    }
    if (
      demoRunning && werewolfEnabled
      && (taskMode === 'circle-target-tracking' || taskMode === 'guide-tracking')
    ) {
      const showWolves = displayMode === 'all-without-avg'
        || displayMode === 'all-with-avg-lines'
        || displayMode === 'all-with-avg-no-lines';
      if (showWolves) {
        for (const wolf of werewolfCursorsRef.current) {
          result.push({
            id: wolf.identity,
            x: wolf.x,
            y: wolf.y,
            diameter: cursorDiameter,
            fill: colorFromIdentity(wolf.identity),
            opacity: cursorOpacity,
            label: shouldShowLabels
              ? { text: wolf.identity, color: 'rgba(30, 41, 59, 0.6)' }
              : undefined,
          });
        }
      }
    }
    return result;
  }, [
    visibleCursors, cursorList, latencyByIdentity, shouldShowLabels, isAdmin,
    participantCursorSize, demoRunning, werewolfEnabled, taskMode, displayMode,
    renderVersion, sketchStyle, shouldRotateTask8SharedDisplay, task9SharedFeedbackCursors,
  ]);

  const p5StageAverages = useMemo<P5Dot[]>(() => {
    if (!showAverageCursor) return [];
    // Group avg uses its own style block; falls back to `average` block, then
    // to app state. Color palette can override the global GROUP_COLORS.
    const groupAvgDiameter = sketchStyle?.groupAverage?.diameter
      ?? sketchStyle?.average?.diameter
      ?? averageCursorSize;
    const groupPalette = sketchStyle?.groupAverage?.colorPalette;
    const colorFor = (gid: number) =>
      (groupPalette && groupPalette.length > 0)
        ? (groupPalette[gid] ?? GROUP_COLOR_FALLBACK)
        : colorForGroup(gid);
    if (groupAverages.size > 0) {
      return Array.from(groupAverages.entries()).map(([gid, pos]) => ({
        id: `group-avg-${gid}`,
        ...(shouldRotateTask8SharedDisplay
          ? rotatePointCounterClockwise90AroundCenter(pos)
          : { x: pos.x, y: pos.y }),
        diameter: groupAvgDiameter,
        fill: colorFor(gid),
        label: shouldShowLabels
          ? { text: `G${gid}`, color: 'rgba(30, 41, 59, 0.6)' }
          : undefined,
      }));
    }
    if (displayedAverageCursor) {
      const avgDiameter = sketchStyle?.average?.diameter ?? averageCursorSize;
      const avgFill = experimentTaskType === 'task9'
        ? getTask9SharedCursorFill(shouldShowTask9SharedFeedback(
          task9SharedFeedbackEnabled,
          sharedCursorControl.enabled,
          sharedCursorControl.phase,
        ))
        : (sketchStyle?.average?.fill ?? '#1d4ed8');
      const pos = shouldRotateTask8SharedDisplay
        ? rotatePointCounterClockwise90AroundCenter(displayedAverageCursor)
        : displayedAverageCursor;
      return [{
        id: 'avg',
        x: pos.x,
        y: pos.y,
        diameter: avgDiameter,
        fill: avgFill,
        label: shouldShowLabels
          ? { text: taskMode === 'shared-single-cursor' ? 'Shared' : 'Avg', color: 'rgba(30, 41, 59, 0.6)' }
          : undefined,
      }];
    }
    return [];
  }, [showAverageCursor, groupAverages, displayedAverageCursor, averageCursorSize, shouldShowLabels, sketchStyle, taskMode, shouldRotateTask8SharedDisplay, experimentTaskType, task9SharedFeedbackEnabled, sharedCursorControl.enabled, sharedCursorControl.phase]);

  const p5StageLines = useMemo<P5Line[]>(() => {
    const result: P5Line[] = [];
    const lineWidth = sketchStyle?.lines?.width ?? 2;
    const lineColorOverride = sketchStyle?.lines?.color;
    const dashed = sketchStyle?.lines?.dashed;
    if (displayMode === 'all-with-avg-lines' && !isAdmin && showAverageCursor && displayedAverageCursor) {
      for (const cursor of visibleCursors) {
        const cursorPos = shouldRotateTask8SharedDisplay
          ? rotatePointCounterClockwise90AroundCenter(cursor)
          : cursor;
        const averagePos = shouldRotateTask8SharedDisplay
          ? rotatePointCounterClockwise90AroundCenter(displayedAverageCursor)
          : displayedAverageCursor;
        result.push({
          x1: cursorPos.x,
          y1: cursorPos.y,
          x2: averagePos.x,
          y2: averagePos.y,
          color: lineColorOverride ?? cursor.color,
          width: lineWidth,
          dashed,
        });
      }
    }
    if (task9SharedFeedbackCursors.length >= 2) {
      const [a, b] = task9SharedFeedbackCursors;
      result.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        color: 'rgba(15, 23, 42, 0.38)',
        width: 2,
      });
    }
    return result;
  }, [displayMode, isAdmin, showAverageCursor, displayedAverageCursor, visibleCursors, sketchStyle, shouldRotateTask8SharedDisplay, task9SharedFeedbackCursors]);

  const [initialWorkspaceTarget, setInitialWorkspaceTarget] = useState(() => getWaitingTargetPosition(0));

  useEffect(() => {
    if (!showTask7WaitingPreview) {
      setInitialWorkspaceTarget(getWaitingTargetPosition(0));
      return;
    }

    let frameId = 0;
    const startedAt = performance.now();
    const animate = (now: number) => {
      setInitialWorkspaceTarget(getWaitingTargetPosition(now - startedAt));
      frameId = requestAnimationFrame(animate);
    };

    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [showTask7WaitingPreview]);

  const initialWorkspaceTargetSize = sketchStyle?.target?.size ?? 24;
  const experimentPreviewCursors = experimentParticipantIdentitySet.size > 0
    ? cursorList.filter((cursor) => experimentParticipantIdentitySet.has(cursor.identity))
    : cursorList.filter((cursor) => !cursor.identity.startsWith('admin:') && !isSyntheticParticipantIdentity(cursor.identity));
  const isInsideInitialWorkspaceTarget = useCallback((cursor: { x: number; y: number }) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const width = Math.max(rect?.width ?? 540, 1);
    const height = Math.max(rect?.height ?? 540, 1);
    const dx = (cursor.x - initialWorkspaceTarget.x) * width;
    const dy = (cursor.y - initialWorkspaceTarget.y) * height;
    return Math.hypot(dx, dy) <= initialWorkspaceTargetSize / 2;
  }, [initialWorkspaceTarget, initialWorkspaceTargetSize]);
  const initialWorkspaceAnyCursorIn = experimentPreviewCursors.some(isInsideInitialWorkspaceTarget);

  const shouldHideTargetForPointerLockPrompt = !isAdmin
    && useVirtualCursor
    && !isPointerLocked;
  const shouldHideTargetForTask7PreTrialCursorSetup = !isAdmin
    && isCursorControlTask
    && useVirtualCursor
    && taskMode !== 'shared-single-cursor';

  const p5StageTarget = useMemo<P5Target | null>(() => {
    if (shouldHideTargetForTask7PreTrialCursorSetup) return null;
    if (shouldHideTargetForPointerLockPrompt) return null;
    if (taskMode === 'shared-single-cursor' && task7PointerLockRecoveryRequired && !isAdmin) return null;
    if (showTask7WaitingPreview) {
      return {
        x: initialWorkspaceTarget.x,
        y: initialWorkspaceTarget.y,
        shape: 'circle',
        size: initialWorkspaceTargetSize,
        fill: getWaitingTargetFill(initialWorkspaceAnyCursorIn),
      };
    }
    if (sharedCursorVisualHidden && taskMode === 'shared-single-cursor' && !isAdmin) return null;
    if (!targetVisible) return null;
    // Color priority: scene.target.color (server-sent, e.g. reaching yellow→
    // red transition) > sketch.style.target.fill > legacy default '#ef4444'.
    // Shape priority: sketch.style.target.shape (sketch forces a shape) >
    // taskMode-based legacy default. Size priority: sketch.style.target.size
    // > legacy mode-specific app-state default.
    const sketchTargetFill = sketchStyle?.target?.fill ?? '#ef4444';
    const sketchTargetShape = sketchStyle?.target?.shape;
    const sketchTargetSize = sketchStyle?.target?.size;
    const fill = taskMode === 'manual-instruction' ? sketchTargetFill : targetState.color ?? sketchTargetFill;
    switch (taskMode) {
      case 'target-tracking':
        return {
          x: targetState.x, y: targetState.y,
          shape: sketchTargetShape ?? 'triangle',
          size: sketchTargetSize ?? 40,
          fill,
        };
      case 'circle-target-tracking':
        // Red square that follows a circular *motion* — matches the
        // agent-side shape publication and the recording shape so
        // live/replay/data all agree.
        return {
          x: targetState.x, y: targetState.y,
          shape: sketchTargetShape ?? 'square',
          size: sketchTargetSize ?? circleTargetSize,
          fill,
        };
      case 'random-target-tracking':
        return {
          x: targetState.x, y: targetState.y,
          shape: sketchTargetShape ?? 'circle',
          size: sketchTargetSize ?? randomTargetSize,
          fill,
        };
      case 'reaching':
        return {
          x: targetState.x, y: targetState.y,
          shape: sketchTargetShape ?? 'circle',
          size: sketchTargetSize ?? circleTargetSize,
          fill,
        };
      case 'shared-single-cursor':
      {
        const pos = shouldRotateTask8SharedDisplay
          ? rotatePointCounterClockwise90AroundCenter(targetState)
          : targetState;
        return {
          x: pos.x, y: pos.y,
          shape: sketchTargetShape ?? 'circle',
          size: sketchTargetSize ?? randomTargetSize,
          fill,
          trajectoryParams: shouldRotateTask8SharedDisplay
            ? { ...targetState.trajectoryParams, displayCoordinateRotation: 'ccw90' }
            : targetState.trajectoryParams,
          trajectoryElapsedMs: targetState.trajectoryElapsedMs,
          trajectoryReceivedAt: targetState.trajectoryReceivedAt,
        };
      }
      default:
        return null;
    }
  }, [targetVisible, taskMode, targetState, circleTargetSize, randomTargetSize, sketchStyle, sharedCursorVisualHidden, isAdmin, showTask7WaitingPreview, initialWorkspaceTarget, initialWorkspaceTargetSize, initialWorkspaceAnyCursorIn, task7PointerLockRecoveryRequired, shouldHideTargetForPointerLockPrompt, shouldHideTargetForTask7PreTrialCursorSetup, shouldRotateTask8SharedDisplay]);

  const p5StageGuide = useMemo<P5Guide | null>(() => {
    if (taskMode !== 'guide-tracking' || !guideTrackingRunning) return null;
    return {
      cx: 0.5,
      cy: 0.5,
      radius: sketchStyle?.guide?.radius ?? circleTargetRadius,
      stroke: sketchStyle?.guide?.stroke ?? '#8b0000',
      strokeWidth: sketchStyle?.guide?.strokeWidth ?? 4,
    };
  }, [taskMode, guideTrackingRunning, circleTargetRadius, sketchStyle]);

  const p5StageYesNo = useMemo<P5YesNo | null>(() => {
    if (taskMode !== 'manual-instruction' || !yesNoAreas.visible) return null;
    return {
      yesPosition: yesNoAreas.yesPosition,
      noPosition: yesNoAreas.noPosition,
      size: sketchStyle?.yesNo?.size ?? 80,
    };
  }, [taskMode, yesNoAreas, sketchStyle]);

  const handleMobileUsernameSubmit = useCallback((username: string) => {
    setMobileUsername(username);
    setIdentityInput(username);
    setHasConsented(true);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('mobile_username', username);
    }
  }, []);

  const handleJoystickMove = useCallback((dx: number, dy: number) => {
    if (connectionState === 'connected' && sendCursorRef.current) {
      // Update mobile cursor position based on velocity delta
      // Don't clamp - allow cursor to move outside [0, 1] stage boundary (same as desktop virtual cursor)
      const prev = mobileCursorPosRef.current;
      const newX = prev.x + dx;
      const newY = prev.y + dy;
      mobileCursorPosRef.current = { x: newX, y: newY };
      setMobileCursorPos({ x: newX, y: newY });
      sendCursorRef.current(newX, newY);
    }
  }, [connectionState]);

  useEffect(() => {
    if (isMobileMode && mobileUsername && connectionState === 'disconnected') {
      connect();
    }
  }, [isMobileMode, mobileUsername, connectionState, connect]);

  useEffect(() => {
    if (isViewerMode && connectionState === 'disconnected') {
      setHasConsented(true);
      connect();
    }
  }, [isViewerMode, connectionState, connect]);

  // Fetch the latency threshold from the server on mount.
  // The agent admin page sets this via the experiment config; falls back to
  // DEFAULT_LATENCY_THRESHOLD_MS if the fetch fails (e.g. server down).
  useEffect(() => {
    if (skipLatencyCheck) {
      return;
    }
    const baseUrl = tokenServerUrl.replace(/\/$/, '');
    let cancelled = false;
    fetch(`${baseUrl}/latency-threshold`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (cancelled || !data) return;
        const t = data.thresholdMs;
        if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
          setLatencyThresholdMs(t);
        }
      })
      .catch((err) => {
        console.warn('Failed to fetch latency threshold', err);
      });
    return () => {
      cancelled = true;
    };
  }, [skipLatencyCheck, tokenServerUrl]);

  // Measure LiveKit RTT for ~10s using a temporary throwaway connection.
  // Computes max/avg/median over collected samples.
  const measureLatency = useCallback(async () => {
    if (latencyMeasuring) {
      return;
    }
    setLatencyMeasuring(true);
    setLatencyMeasureError(null);
    setLatencyMeasurement(null);
    setLatencyMeasureProgress(0);
    setLatencyCurrentRttMs(null);

    const SAMPLE_DURATION_MS = 10_000;
    const SAMPLE_INTERVAL_MS = 250;
    // Skip the first ~2 s of samples. During ICE establishment a burst of
    // rapid connectivity checks can briefly report artificially low RTT;
    // including those in the median lets transient connection-time good luck
    // dominate the steady-state STUN consent measurements that the gate
    // really cares about. Live UI still shows readings during warmup so the
    // participant gets immediate feedback that the check is running.
    const WARMUP_MS = 2000;

    let measurementRoom: Room | null = null;
    try {
      const baseUrl = tokenServerUrl.replace(/\/$/, '');
      const url = new URL(`${baseUrl}/token`);
      // Isolated room name + identity so we never collide with the live room.
      const suffix = Math.random().toString(36).slice(2, 10);
      url.searchParams.set('room', `latency-check-${suffix}`);
      url.searchParams.set('identity', `latency-${suffix}`);
      if (typeof window !== 'undefined' && window.location.hostname) {
        url.searchParams.set('publicHost', window.location.hostname);
      }

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Token request failed (${response.status})`);
      }
      const payload = (await response.json()) as TokenResponse;

      ensureMediaDevicesEventTargetCompat();
      measurementRoom = new Room();
      await measurementRoom.connect(payload.url, payload.token);

      // Publish a tiny data message so the publisher transport is created
      // (otherwise getRttMs may only have the subscriber to read from on
      // first samples).
      try {
        const ping = new TextEncoder().encode('{"type":"latency-ping"}');
        measurementRoom.localParticipant.publishData(ping, { reliable: true, topic: 'latency-check' });
      } catch {
        // Non-fatal — subscriber transport stats are usually enough.
      }

      const samples: number[] = [];
      const startedAt = Date.now();

      while (Date.now() - startedAt < SAMPLE_DURATION_MS) {
        const elapsed = Date.now() - startedAt;
        const rtt = await getRttMs(measurementRoom);
        if (rtt !== null && rtt > 0) {
          setLatencyCurrentRttMs(rtt);
          if (elapsed >= WARMUP_MS) {
            samples.push(rtt);
          }
        }
        setLatencyMeasureProgress(Math.min(1, elapsed / SAMPLE_DURATION_MS));
        await new Promise((resolve) => window.setTimeout(resolve, SAMPLE_INTERVAL_MS));
      }
      setLatencyMeasureProgress(1);

      if (samples.length === 0) {
        throw new Error('Could not measure latency. Please check your connection and try again.');
      }

      const max = Math.max(...samples);
      const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length;
      const sorted = [...samples].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

      setLatencyMeasurement({
        max: Math.round(max),
        avg: Math.round(avg),
        median: Math.round(median),
        sampleCount: samples.length,
      });
    } catch (err) {
      console.error('Latency measurement failed', err);
      setLatencyMeasureError(err instanceof Error ? err.message : 'Measurement failed');
    } finally {
      // Flip measuring off FIRST so the result/error UI can render
      // immediately. Awaiting disconnect under a slow connection kept the
      // modal stuck on "Measuring…" even after samples were collected.
      setLatencyMeasuring(false);
      if (measurementRoom) {
        measurementRoom.removeAllListeners();
        measurementRoom.disconnect().catch((err) => {
          console.warn('Failed to disconnect measurement room', err);
        });
      }
    }
  }, [latencyMeasuring, tokenServerUrl]);

  if (isMobileMode) {
    if (!mobileUsername) {
      return <MobileEntryScreen onSubmit={handleMobileUsernameSubmit} />;
    }
    const mobileColor = localIdentityRef.current ? colorFromIdentity(localIdentityRef.current) : '#f8fafc';
    return (
      <div className="app mobile-app" style={{ background: mobileColor }}>
        <MobileController 
          onJoystickMove={handleJoystickMove} 
          connectionState={connectionState}
          joystickMultiplier={joystickMultiplier}
        />
      </div>
    );
  }

  if (isViewerMode) {
    return (
      <div className="app viewer-app">
        <ViewerMode
          cursors={cursorList}
          averageCursor={averageCursor}
          groupAverages={groupAverages}
          displayMode={displayMode}
          targetState={targetState}
          targetVisible={targetVisible}
          taskMode={taskMode}
          yesNoAreas={yesNoAreas}
          broadcastMessages={broadcastMessages}
          circleTargetRadius={circleTargetRadius}
          guideTrackingRunning={guideTrackingRunning}
          participantCursorSize={participantCursorSize}
          averageCursorSize={averageCursorSize}
          circleTargetSize={circleTargetSize}
          randomTargetSize={randomTargetSize}
          werewolfCursors={receivedWerewolfCursorsRef.current}
        />
      </div>
    );
  }

  if (participationCancelled) {
    return (
      <div className="app">
        <div className="kicked-screen withdrawal-screen">
          <div className="kicked-content">
            <h1>Participation Cancelled</h1>
            <p>Thank you for your interest in our study.</p>
            {participationCancelledReason === 'declined' ? (
              <p>
                You selected <strong>I Do Not Agree</strong>, so you will not
                take part in this study.
              </p>
            ) : (
              <p>
                This experiment runs in real time and requires all participants
                to start together. You did not complete the internet-speed check
                and consent within the {CONSENT_DEADLINE_SECONDS}-second time
                limit, so we are unable to include you in this session.
              </p>
            )}
            <h3>Please return your submission on Prolific</h3>
            <p>
              We kindly ask you to <strong>return your submission</strong> on
              Prolific so that this session is not counted as a completion.
              To do this:
            </p>
            <ul>
              <li>Go back to the Prolific study page</li>
              <li>Click <strong>"Stop without completing"</strong></li>
              <li>Select <strong>"Return submission"</strong></li>
            </ul>
            <p>
              Returning a submission is the standard action when you cannot
              complete a study. It does <strong>not</strong> negatively affect
              your Prolific account.
            </p>
            <p>Thank you for your understanding.</p>
            <div className="kicked-buttons">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    window.location.href = 'https://app.prolific.com/';
                  }
                }}
              >
                Go to Prolific
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (participantTerminationOutcome) {
    const terminationKind = classifyParticipantTermination(participantTerminationOutcome);
    const preExperimentReturnNotice = getPreExperimentReturnNotice(terminationKind);
    const elapsedMinutes = Math.max(1, Math.ceil(participantTerminationOutcome.elapsedSeconds / 60));
    return (
      <div className="app">
        <div className="kicked-screen withdrawal-screen">
          <div className="kicked-content">
            <h1>Experiment Ended</h1>
            {terminationKind === 'no-match' ? (
              <>
                <p>No other participant joined within the five-minute waiting period, so this session cannot begin.</p>
                <h3>Please return your submission on Prolific</h3>
                <p>
                  As stated in the study information, the waiting period is not included in the experiment time
                  and is not eligible for the standard reward.
                </p>
              </>
            ) : terminationKind === 'start-timeout-no-payment' ? (
              <>
                <p>The two-minute START confirmation period ended before the experiment began.</p>
                <h3>Please return your submission on Prolific</h3>
                <p>
                  Because the experiment did not begin, this submission is not eligible for the standard reward.
                </p>
              </>
            ) : terminationKind === 'responsible' ? (
              <>
                <p>
                  Your participation ended because no cursor activity was received for the allowed period,
                  or because this participant page was closed or left.
                </p>
                <h3>Please return your submission on Prolific</h3>
                <p>This submission is not eligible for the standard reward.</p>
              </>
            ) : (
              <>
                <p>The other participant left the experiment or stopped responding, so this paired session cannot continue.</p>
                <p><strong>This was not caused by you.</strong></p>
                <h3>Please return your submission on Prolific</h3>
                <p>
                  Your participation time ({elapsedMinutes} minute{elapsedMinutes === 1 ? '' : 's'}) has been recorded.
                  The researcher will review it for partial compensation, or full compensation when most of the experiment was completed.
                </p>
              </>
            )}
            {preExperimentReturnNotice && <p>{preExperimentReturnNotice}</p>}
            <ol>
              <li>Return to the Prolific study page.</li>
              <li>Click <strong>Stop without completing</strong>.</li>
              <li>Select <strong>Return submission</strong>.</li>
            </ol>
            <p>Returning the submission does not negatively affect your Prolific account.</p>
            <div className="kicked-buttons">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  window.location.href = 'https://app.prolific.com/';
                }}
              >
                Go to Prolific
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isKicked) {
    return (
      <div className="app">
        <div className="kicked-screen">
          <div className="kicked-content">
            <h1>Participation Ended</h1>
            <p>Thank you for your interest and participation in this study.</p>
            <p>
              Unfortunately, you have been disconnected from the experiment for one or both of the following reasons:
            </p>
            <ul>
              <li>
                <strong>Internet Connection Issues:</strong> This experiment requires real-time interaction between multiple participants. If there is significant latency due to internet speed, it impacts the integrity of the data.
              </li>
              <li>
                <strong>Performance Requirements:</strong> This study involves a collaborative task. If a participant's responses are inconsistent or if technical issues (like the internet speed mentioned above) hinder the group's progress, it affects the overall performance of the session.
              </li>
            </ul>
            <p>Please click the button below to proceed to the page for your compensation.</p>
            <div className="kicked-buttons">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    window.location.href = KICK_COMPLETION_URL;
                  }
                }}
              >
                Proceed to Compensation
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!hasConsented && !isSimMode) {
    return (
      <div className="app">
        <div className="consent-screen">
          <div className="consent-content">
            {!skipLatencyCheck && (
              <div
                className={`consent-deadline-banner${consentSecondsRemaining <= 30 ? ' consent-deadline-banner--urgent' : ''}`}
                role="status"
                aria-live="polite"
              >
                <span className="consent-deadline-banner__label">
                  Please complete this page within the time limit.
                </span>
                <span className="consent-deadline-banner__time">
                  {Math.floor(consentSecondsRemaining / 60)}:
                  {(consentSecondsRemaining % 60).toString().padStart(2, '0')}
                </span>
              </div>
            )}
            <h1>Online Point-to-Point Task</h1>
            <h2>Participant Information and Consent</h2>

            <div className="consent-text">
              <h3>Study Overview</h3>
              <p>
                You are invited to participate in a research study investigating real-time cursor coordination 
                in online collaborative environments. This study will take approximately <strong>15 minutes</strong> to complete.
              </p>
              
              <h3>What You Will Do</h3>
              <ul>
                <li>
                  Use your mouse/trackpad to move a circular cursor
                  <img
                    src="/instruction1.png"
                    alt="Mouse or trackpad control moves a circular cursor."
                    className="consent-instruction-image"
                  />
                </li>
                <li className="consent-instruction-spaced">
                  Reach as many targets as possible within the time limit
                  <img
                    src="/instruction2.png"
                    alt="Cursor reaches as many targets as possible within the time limit."
                    className="consent-instruction-image"
                  />
                </li>
                <li className="consent-instruction-spaced">
                  Later in the task, control a shared cursor with another participant
                  <img
                    src="/instruction3.png"
                    alt="Two participants control a shared cursor together."
                    className="consent-instruction-image"
                  />
                </li>
                <li className="consent-instruction-spaced">
                  {SHARED_CONTRIBUTION_CONSENT_COPY}
                </li>
              </ul>
              
              <h3>Data Collection</h3>
              <p>
                We will collect:
              </p>
              <ul>
                {CONSENT_DATA_COLLECTION_ITEMS.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>
                All data will be anonymized and used solely for research purposes.
              </p>
              
              <h3>Risks and Benefits</h3>
              <p>
                There are no known risks associated with this study. While there are no direct benefits to you, 
                your participation will contribute to research on human coordination and collaboration.
              </p>
              
              <h3>Voluntary Participation</h3>
              <p>
                Your participation is completely voluntary. You may withdraw from the study at any time without penalty. If you have any questions or concerns, please contact the researcher via the study platform.
              </p>
              
              <div className="important-instructions">
                <h3>Important Instructions</h3>
                <ul>
                  <li>
                    This experiment will begin once <strong>TWO</strong> participants have joined. There are no scheduled breaks during this study.
                  </li>
                  <li>
                    Please be aware that you may need to wait up to 5 minutes for the other participant to join, and this waiting time is <strong>NOT INCLUDED</strong> in the compensation.
                  </li>
                  <li>
                    Once the experiment begins, <strong>DO NOT REFRESH THIS PAGE, PRESS F5, OR CLOSE THIS BROWSER TAB.</strong>{' '}
                    Doing so may disconnect you from the experiment and interrupt the session.
                  </li>
                  <li>Please note!! If either participant stops the task before completion, the session will end, and <strong>NEITHER</strong> participant will receive the reward in some cases.</li>
                  <li>Please start only when you can focus on the task continuously for about <strong>15 MINUTES</strong>.</li>
                </ul>
              </div>
              
              <h3>Consent</h3>
              <p>
                By clicking "I Agree and Continue" below, you confirm that:
              </p>
              <ul>
                <li>You have read and understood this information</li>
                <li>You are at least 18 years old</li>
                <li>You voluntarily agree to participate in this study</li>
              </ul>
            </div>
            
            <div className="consent-buttons">
              <button
                type="button"
                className="primary"
                disabled={!latencyCheckPassed}
                onClick={() => setHasConsented(true)}
              >
                I Agree and Continue
              </button>
              <button
                type="button"
                onClick={() => {
                  setParticipationCancelledReason('declined');
                  setParticipationCancelled(true);
                }}
              >
                I Do Not Agree
              </button>
            </div>
          </div>
          {!latencyCheckPassed && (() => {
            const result = latencyMeasurement;
            const passed = result !== null && result.median <= latencyThresholdMs;
            const failed = result !== null && result.median > latencyThresholdMs;
            return (
              <div className="latency-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="latency-modal-title">
                <div className="latency-modal">
                  <h2 id="latency-modal-title">Internet Speed Check</h2>
                  {!result && !latencyMeasuring && !latencyMeasureError && (
                    <>
                      <p>
                        Before participating, please measure your connection latency to our server.
                        This helps us run the experiment smoothly.
                      </p>
                      <p>
                        The measurement takes about 10 seconds. To take part in the experiment,
                        your median latency must be <strong>{latencyThresholdMs} ms or less</strong>.
                      </p>
                      <div className="latency-modal-buttons">
                        <button type="button" className="primary" onClick={measureLatency}>
                          Measure the Internet speed
                        </button>
                      </div>
                    </>
                  )}
                  {latencyMeasuring && (
                    <>
                      <p>Measuring your connection to the LiveKit server…</p>
                      <div className="latency-progress-track">
                        <div
                          className="latency-progress-bar"
                          style={{ width: `${Math.round(latencyMeasureProgress * 100)}%` }}
                        />
                      </div>
                      <div className="latency-progress-meta">
                        <span>{Math.round(latencyMeasureProgress * 10)} / 10 seconds</span>
                        {latencyCurrentRttMs !== null && (
                          <span>Current RTT: <strong>{latencyCurrentRttMs} ms</strong></span>
                        )}
                      </div>
                    </>
                  )}
                  {latencyMeasureError && !latencyMeasuring && (
                    <>
                      <p className="latency-error">{latencyMeasureError}</p>
                      <div className="latency-modal-buttons">
                        <button type="button" className="primary" onClick={measureLatency}>
                          Try Again
                        </button>
                      </div>
                    </>
                  )}
                  {result && !latencyMeasuring && (
                    <>
                      <div className="latency-result-grid">
                        <div className="latency-result-cell">
                          <div className="latency-result-label">Median</div>
                          <div className={`latency-result-value ${passed ? 'good' : 'bad'}`}>{result.median} ms</div>
                        </div>
                        <div className="latency-result-cell">
                          <div className="latency-result-label">Average</div>
                          <div className="latency-result-value">{result.avg} ms</div>
                        </div>
                        <div className="latency-result-cell">
                          <div className="latency-result-label">Maximum</div>
                          <div className="latency-result-value">{result.max} ms</div>
                        </div>
                      </div>
                      <p className="latency-result-meta">
                        {result.sampleCount} samples over 10 seconds
                      </p>
                      {passed && (
                        <>
                          <p className="latency-result-message good">
                            Your connection meets the requirement. Thank you — you may continue.
                          </p>
                          <div className="latency-modal-buttons">
                            <button
                              type="button"
                              className="primary"
                              onClick={() => setLatencyCheckPassed(true)}
                            >
                              Continue
                            </button>
                          </div>
                        </>
                      )}
                      {failed && (
                        <>
                          <p className="latency-result-message bad">
                            Unfortunately, your connection latency is too high (median &gt; {latencyThresholdMs} ms),
                            so you cannot participate in this experiment. We are sorry for the
                            inconvenience. You may close this window.
                          </p>
                          <div className="latency-modal-buttons">
                            <button type="button" onClick={measureLatency}>
                              Measure Again
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (typeof window !== 'undefined') {
                                  window.close();
                                }
                              }}
                            >
                              Close Window
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className={`header${isAdmin ? ' admin-header' : ''}`}>
        <h1>Online Cursor Tracking</h1>
        <div className="control-group">
          {showAdvanced && (
            <>
              <label>
                Token server
                <input
                  value={tokenServerUrl}
                  onChange={(event) => setTokenServerUrl(event.target.value)}
                  placeholder="http://localhost:3001"
                  disabled={connectionState !== 'disconnected'}
                />
              </label>
              <label>
                Room
                <input
                  value={roomName}
                  onChange={(event) => setRoomName(event.target.value)}
                  disabled={connectionState !== 'disconnected'}
                />
              </label>
            </>
          )}
        </div>
        {(isAdmin || showAdvanced) && (
          <div className="control-group">
            <button
              type="button"
              className="primary"
              disabled={connectButtonDisabled}
              onClick={connect}
            >
              {connectionState === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            {disconnectButtonVisible && (
              <button type="button" onClick={disconnect}>
                Disconnect
              </button>
            )}
          </div>
        )}
        {isAdmin && (
          <>
            <div className="admin-status-bar">
              <span style={{ color: connectionState === 'connected' ? '#10b981' : connectionState === 'connecting' ? '#f59e0b' : '#94a3b8', fontSize: '0.6rem' }}>&#9679;</span>
              {connectionState}
              <span className="sep">|</span>
              <strong>{cursorList.length}</strong> cursors
              {connectionState === 'connected' && localRttMs !== null && (
                <>
                  <span className="sep">|</span>
                  <span style={{ color: localRttMs < 50 ? '#10b981' : localRttMs < 150 ? '#f59e0b' : '#dc2626' }}>{localRttMs}ms</span>
                </>
              )}
              {isRecording && (
                <>
                  <span className="sep">|</span>
                  <span style={{ color: '#dc2626', fontWeight: 700 }}>REC</span>
                </>
              )}
            </div>
          </>
        )}
        {isParticipantPage && task7WaitSecondsRemaining !== null && (
          <div className="status">
            Partner join time remaining: {Math.floor(task7WaitSecondsRemaining / 60).toString().padStart(2, '0')}:{(task7WaitSecondsRemaining % 60).toString().padStart(2, '0')} (waiting time unpaid)
          </div>
        )}
        {!isAdmin && !isParticipantPage && (
          <div className="status">
            Status: {connectionState}
            <span>&middot;</span>
            Participants: {realParticipantConnectionCount}
            {connectionState === 'connected' && localRttMs !== null && (
              <>
                <span>&middot;</span>
                <span>RTT: {localRttMs}ms</span>
              </>
            )}
          </div>
        )}
      </header>

      <div className={isAdmin ? "admin-dashboard" : ""}>
        {isAdmin && (
          <aside className="admin-controls-panel" style={{ width: leftPanelWidth }}>
            {adminMode === 'experiment' && (<>

                <AdminAgentControls
                  baseUrl={tokenServerUrl}
                  adminPassword={adminPassword}
                  roomName={roomName}
                  connected={connectionState === 'connected'}
                  showSharedCursorFeedback={task9SharedFeedbackEnabled}
                  onShowSharedCursorFeedbackChange={updateTask9SharedFeedback}
                />

                {/* Task Control Section */}
                <div className="ctrl-section">
                  <h4>Task Control</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('target-tracking')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'target-tracking' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'target-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'target-tracking' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 1: Target Tracking
                    </button>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('manual-instruction')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'manual-instruction' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'manual-instruction' ? 'white' : '#374151',
                        fontWeight: taskMode === 'manual-instruction' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 2: Manual Instruction
                    </button>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('circle-target-tracking')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'circle-target-tracking' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'circle-target-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'circle-target-tracking' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 3: Circle Target Tracking
                    </button>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('guide-tracking')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'guide-tracking' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'guide-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'guide-tracking' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 4: Guide Tracking
                    </button>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('random-target-tracking')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'random-target-tracking' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'random-target-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'random-target-tracking' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 5: Random Target Tracking
                    </button>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('shared-single-cursor', 'shared-single-cursor-control')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && !isCursorControlExperimentTask(experimentTaskType) ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && !isCursorControlExperimentTask(experimentTaskType) ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && !isCursorControlExperimentTask(experimentTaskType) ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 6: Shared/Single Cursor Control
                    </button>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('shared-single-cursor', 'cursor-control-20260706')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && experimentTaskType === 'cursor-control-20260706' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && experimentTaskType === 'cursor-control-20260706' ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && experimentTaskType === 'cursor-control-20260706' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 1: Joint Cursor 260917
                    </button>
                    <button
                      type="button"
                      hidden
                      onClick={() => updateTaskMode('shared-single-cursor', 'task8')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && experimentTaskType === 'task8' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && experimentTaskType === 'task8' ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && experimentTaskType === 'task8' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task8: Cursor Control 20260724
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('shared-single-cursor', 'task9')}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && experimentTaskType === 'task9' ? '#3b82f6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && experimentTaskType === 'task9' ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && experimentTaskType === 'task9' ? 'bold' : 'normal',
                        border: 'none',
                        borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Point-to-Point Task
                    </button>
                  </div>
                </div>

                {/* Virtual Cursor Controls Section */}
                <div className="ctrl-section" style={{ display: 'none' }}>
                  <h4>Virtual Cursor</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.875rem', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}>
                      <input
                        type="checkbox"
                        checked={useVirtualCursor}
                        onChange={(e) => updateUseVirtualCursor(e.target.checked)}
                        disabled={connectionState !== 'connected'}
                        style={{ marginRight: '0.5rem', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                      />
                      Use Virtual Cursor for Average
                    </label>
                    <button
                      type="button"
                      onClick={() => updateShowClickAreaOverlay(!showClickAreaOverlay)}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: showClickAreaOverlay ? '#10b981' : '#3b82f6',
                        color: 'white',
                        border: 'none',
                        borderRadius: '0.375rem',
                        fontWeight: '500',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {showClickAreaOverlay ? 'Hide Click Area Overlay' : 'Show Click Area Overlay'}
                    </button>
                    <button
                      type="button"
                      onClick={unlockParticipantPointerLock}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: '#ef4444',
                        color: 'white',
                        border: 'none',
                        borderRadius: '0.375rem',
                        fontWeight: '500',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Unlock Participant Pointer Lock
                    </button>
                    <button
                      type="button"
                      onClick={resetVirtualCursorPosition}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: '#f59e0b',
                        color: 'white',
                        border: 'none',
                        borderRadius: '0.375rem',
                        fontWeight: '500',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Reset Position
                    </button>
                  </div>
                </div>

                {/* Mobile Controls Section */}
                <div className="ctrl-section" style={{ display: 'none' }}>
                  <h4>Mobile Controls</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.875rem', minWidth: '120px' }}>Joystick Multiplier:</label>
                      <input
                        type="range"
                        min="0.1"
                        max="3.0"
                        step="0.1"
                        value={joystickMultiplier}
                        onChange={(e) => updateJoystickMultiplier(parseFloat(e.target.value))}
                        disabled={connectionState !== 'connected'}
                        style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                      />
                      <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{joystickMultiplier.toFixed(1)}x</span>
                    </div>
                    <button
                      type="button"
                      onClick={resetMobileCursorPosition}
                      disabled={connectionState !== 'connected'}
                      style={{
                        padding: '0.5rem',
                        background: '#f59e0b',
                        color: 'white',
                        border: 'none',
                        borderRadius: '0.375rem',
                        fontWeight: '500',
                        cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Reset Mobile Cursor Position
                    </button>
                  </div>
                </div>

                {/* Cursor Property Section */}
                <div className="ctrl-section" style={{ display: 'none' }}>
                  <h4>Cursor Size</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.875rem', minWidth: '140px' }}>Participant Cursor:</label>
                      <input
                        type="range"
                        min="6"
                        max="50"
                        step="1"
                        value={participantCursorSize}
                        onChange={(e) => updateCursorSize(parseInt(e.target.value), averageCursorSize)}
                        disabled={connectionState !== 'connected'}
                        style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                      />
                      <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{participantCursorSize}px</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.875rem', minWidth: '140px' }}>Average Cursor:</label>
                      <input
                        type="range"
                        min="6"
                        max="50"
                        step="1"
                        value={averageCursorSize}
                        onChange={(e) => updateCursorSize(participantCursorSize, parseInt(e.target.value))}
                        disabled={connectionState !== 'connected'}
                        style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                      />
                      <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{averageCursorSize}px</span>
                    </div>
                  </div>
                </div>

                {/* Broadcast Message Section */}
                <div className="ctrl-section" style={{ display: 'none' }}>
                  <h4>Broadcast</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <input
                      type="text"
                      value={broadcastText}
                      onChange={(e) => setBroadcastText(e.target.value)}
                      placeholder="Message to all participants"
                      disabled={connectionState !== 'connected'}
                      style={{ padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }}
                    />
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        type="number"
                        value={broadcastDuration}
                        onChange={(e) => setBroadcastDuration(Number(e.target.value))}
                        min="1000"
                        max="30000"
                        step="1000"
                        disabled={connectionState !== 'connected'}
                        style={{ width: '100px', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }}
                        title="Duration in milliseconds"
                      />
                      <button
                        type="button"
                        onClick={() => sendBroadcastMessage(broadcastText, broadcastDuration)}
                        disabled={connectionState !== 'connected' || !broadcastText.trim()}
                        style={{ flex: 1, padding: '0.5rem', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: (connectionState === 'connected' && broadcastText.trim()) ? 'pointer' : 'not-allowed' }}
                      >
                        Send
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={openTemplateWindow}
                      disabled={connectionState !== 'connected'}
                      style={{ padding: '0.5rem', background: '#8b5cf6', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                    >
                      Template Messages
                    </button>
                  </div>
                </div>

                {/* Display Settings Section */}
                <div className="ctrl-section" style={{ display: 'none' }}>
                  <h4>Display</h4>
                  <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                    Participant Display Mode:
                    <select
                      value={displayMode}
                      onChange={(e) => updateDisplayMode(e.target.value as DisplayMode)}
                      disabled={connectionState !== 'connected'}
                      style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }}
                    >
                      <option value="all-without-avg">All Cursors without Avg cursor</option>
                      <option value="all-with-avg-lines">All Cursors and Average Cursor with Lines</option>
                      <option value="all-with-avg-no-lines">All Cursors and Average Cursor without Lines</option>
                      <option value="avgOnly">Average Only</option>
                      <option value="self">Self Only</option>
                      <option value="self-with-avg">Self + Average Cursor</option>
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.875rem', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}>
                    <input
                      type="checkbox"
                      checked={hideCursor}
                      onChange={(e) => updateHideCursor(e.target.checked)}
                      disabled={connectionState !== 'connected'}
                      style={{ marginRight: '0.5rem', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                    />
                    Hide Participant Cursor on Stage
                  </label>
                </div>

                {/* Recording Section */}
                <div className="ctrl-section ctrl-section--rec" style={{ display: 'none' }}>
                  <h4>Recording</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: '#374151' }}>
                      Experiment name
                      <input
                        type="text"
                        value={experimentName}
                        onChange={(e) => setExperimentName(e.target.value)}
                        placeholder="(optional)"
                        disabled={isRecording || isUploading}
                        style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db', boxSizing: 'border-box' }}
                      />
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151', padding: '0.25rem 0' }}>
                      <span style={{ fontWeight: '500' }}>Trial Number:</span>
                      <span style={{ fontWeight: '600', color: '#2563eb' }}>{trialNumber}</span>
                    </div>
                    {!isRecording && !isUploading && (
                      <button
                        type="button"
                        onClick={startRecording}
                        disabled={connectionState !== 'connected'}
                        style={{ padding: '0.5rem', background: '#dc2626', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                      >
                        Start Recording
                      </button>
                    )}
                    {isRecording && (
                      <>
                        <button
                          type="button"
                          onClick={stopRecording}
                          disabled={isUploading}
                          style={{ padding: '0.5rem', background: '#dc2626', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', animation: 'pulse 2s infinite', cursor: isUploading ? 'not-allowed' : 'pointer' }}
                        >
                          Stop Recording
                        </button>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151', padding: '0.25rem 0' }}>
                          <span style={{ fontWeight: '500' }}>Elapsed Time:</span>
                          <span style={{ fontWeight: '600', color: '#dc2626' }}>
                            {Math.floor(recordingElapsedSeconds / 60)}:{(recordingElapsedSeconds % 60).toString().padStart(2, '0')}
                          </span>
                        </div>
                      </>
                    )}
                    {uploadProgress !== null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151' }}>
                          <span style={{ fontWeight: '500' }}>Uploading to Supabase...</span>
                          <span style={{ fontWeight: '600', color: uploadProgress === 100 ? '#10b981' : '#2563eb' }}>{uploadProgress}%</span>
                        </div>
                        <div style={{ width: '100%', height: '6px', background: '#e5e7eb', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ width: `${uploadProgress}%`, height: '100%', background: uploadProgress === 100 ? '#10b981' : '#2563eb', transition: 'width 0.2s ease' }} />
                        </div>
                        {uploadProgress === 100 && (
                          <span style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: '500' }}>Upload complete!</span>
                        )}
                      </div>
                    )}
                    {recordingSession && !isUploading && (
                      <>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={downloadRecording}
                            disabled={isRecording}
                            style={{ flex: 1, padding: '0.5rem', background: '#6b7280', color: 'white', border: 'none', borderRadius: '0.375rem', fontSize: '0.875rem', cursor: isRecording ? 'not-allowed' : 'pointer' }}
                          >
                            Download
                          </button>
                          <button
                            type="button"
                            onClick={clearRecording}
                            disabled={isRecording}
                            style={{ flex: 1, padding: '0.5rem', background: '#6b7280', color: 'white', border: 'none', borderRadius: '0.375rem', fontSize: '0.875rem', cursor: isRecording ? 'not-allowed' : 'pointer' }}
                          >
                            Clear
                          </button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', padding: '0.5rem', background: '#f3f4f6', borderRadius: '0.375rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151' }}>
                            <span style={{ fontWeight: '500' }}>Frames:</span>
                            <span>{recordingSession.frames.length.toLocaleString()}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151' }}>
                            <span style={{ fontWeight: '500' }}>Data Size:</span>
                            <span>{getRecordingDataSize(recordingSession)}</span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Session Control Section */}
                <div className="ctrl-section">
                  <h4>Session</h4>
                  <button
                    type="button"
                    onClick={triggerSessionCompletion}
                    disabled={connectionState !== 'connected'}
                    style={{ width: '100%', padding: '0.5rem', background: '#10b981', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                  >
                    End Session
                  </button>
                </div>
            </>)}

            {false && (<>
                {/* Task Control Section (no Manual Instruction) */}
                <div className="ctrl-section">
                  <h4>Task Control</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('target-tracking')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'target-tracking' ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'target-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'target-tracking' ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 1: Target Tracking
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('circle-target-tracking')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'circle-target-tracking' ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'circle-target-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'circle-target-tracking' ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 3: Circle Target Tracking
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('guide-tracking')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'guide-tracking' ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'guide-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'guide-tracking' ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 4: Guide Tracking
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('random-target-tracking')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'random-target-tracking' ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'random-target-tracking' ? 'white' : '#374151',
                        fontWeight: taskMode === 'random-target-tracking' ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 5: Random Target Tracking
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('shared-single-cursor', 'shared-single-cursor-control')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && !isCursorControlExperimentTask(experimentTaskType) ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && !isCursorControlExperimentTask(experimentTaskType) ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && !isCursorControlExperimentTask(experimentTaskType) ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 6: Shared/Single Cursor Control
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('shared-single-cursor', 'cursor-control-20260706')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && experimentTaskType === 'cursor-control-20260706' ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && experimentTaskType === 'cursor-control-20260706' ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && experimentTaskType === 'cursor-control-20260706' ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task 7: Cursor Control Task7
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('shared-single-cursor', 'task8')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && experimentTaskType === 'task8' ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && experimentTaskType === 'task8' ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && experimentTaskType === 'task8' ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task8: Cursor Control 20260724
                    </button>
                    <button
                      type="button"
                      onClick={() => updateTaskMode('shared-single-cursor', 'task9')}
                      disabled={connectionState !== 'connected' || demoRunning}
                      style={{
                        padding: '0.5rem',
                        background: taskMode === 'shared-single-cursor' && experimentTaskType === 'task9' ? '#8b5cf6' : '#e5e7eb',
                        color: taskMode === 'shared-single-cursor' && experimentTaskType === 'task9' ? 'white' : '#374151',
                        fontWeight: taskMode === 'shared-single-cursor' && experimentTaskType === 'task9' ? 'bold' : 'normal',
                        border: 'none', borderRadius: '0.375rem',
                        cursor: connectionState === 'connected' && !demoRunning ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Task9: Cursor Control
                    </button>
                  </div>
                </div>

                {/* Circle Target Controls (demo) */}
                {taskMode === 'circle-target-tracking' && (
                  <div className="ctrl-section">
                    <h4>Circle Target</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <label style={{ fontSize: '0.875rem', minWidth: '100px' }}>Target Size:</label>
                        <input type="range" min="10" max="80" step="1" value={circleTargetSize} onChange={(e) => updateTargetSize(parseInt(e.target.value), randomTargetSize)} disabled={connectionState !== 'connected'} style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }} />
                        <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{circleTargetSize}px</span>
                      </div>
                      <label style={{ display: 'block', fontSize: '0.875rem' }}>
                        Period (ms):
                        <input type="number" value={circleTargetPeriod} onChange={(e) => setCircleTargetPeriod(Number(e.target.value))} min="1000" max="30000" step="100" disabled={connectionState !== 'connected' || circleTargetRunning} style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }} />
                      </label>
                      <label style={{ display: 'block', fontSize: '0.875rem' }}>
                        Circle Radius (0-0.5):
                        <input type="number" value={circleTargetRadius} onChange={(e) => setCircleTargetRadius(Number(e.target.value))} min="0.1" max="0.5" step="0.01" disabled={connectionState !== 'connected' || circleTargetRunning} style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }} />
                      </label>
                      <label style={{ display: 'block', fontSize: '0.875rem' }}>
                        Display Duration (seconds):
                        <input type="number" value={circleTargetDuration / 1000} onChange={(e) => setCircleTargetDuration(Number(e.target.value) * 1000)} min="1" max="300" step="1" disabled={connectionState !== 'connected' || circleTargetRunning} style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }} />
                      </label>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          onClick={startCircleTarget}
                          disabled={connectionState !== 'connected' || circleTargetRunning}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: circleTargetRunning ? '#94a3b8' : '#10b981',
                            color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '600',
                            cursor: connectionState === 'connected' && !circleTargetRunning ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Start
                        </button>
                        <button
                          type="button"
                          onClick={resetCircleTarget}
                          disabled={connectionState !== 'connected'}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: '#ef4444',
                            color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '600',
                            cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Reset
                        </button>
                      </div>
                      {circleTargetTimerActive && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151', padding: '0.25rem 0' }}>
                          <span style={{ fontWeight: '500' }}>Elapsed:</span>
                          <span style={{ fontWeight: '600', color: '#8b5cf6' }}>
                            {Math.floor(circleTargetElapsedTime / 60)}:{(circleTargetElapsedTime % 60).toString().padStart(2, '0')}
                            {' / '}
                            {Math.floor(circleTargetDuration / 60000)}:{((circleTargetDuration / 1000) % 60).toString().padStart(2, '0')}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Guide Tracking Controls (demo) */}
                {taskMode === 'guide-tracking' && (
                  <div className="ctrl-section">
                    <h4>Guide Tracking</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          onClick={startGuideTracking}
                          disabled={connectionState !== 'connected' || guideTrackingTimerActive}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: guideTrackingTimerActive ? '#94a3b8' : '#10b981',
                            color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '600',
                            cursor: connectionState === 'connected' && !guideTrackingTimerActive ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Start
                        </button>
                        <button
                          type="button"
                          onClick={resetGuideTracking}
                          disabled={connectionState !== 'connected'}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: '#ef4444',
                            color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '600',
                            cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Reset
                        </button>
                      </div>
                      {guideTrackingTimerActive && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151', padding: '0.25rem 0' }}>
                          <span style={{ fontWeight: '500' }}>Elapsed:</span>
                          <span style={{ fontWeight: '600', color: guideTrackingRunning ? '#8b5cf6' : '#94a3b8' }}>
                            {Math.floor(guideTrackingElapsedTime / 60)}:{(guideTrackingElapsedTime % 60).toString().padStart(2, '0')}
                            {!guideTrackingRunning && ' (guide hidden)'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Random Target Tracking Controls (demo) */}
                {taskMode === 'random-target-tracking' && (
                  <div className="ctrl-section">
                    <h4>Random Target</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <label style={{ fontSize: '0.875rem', minWidth: '100px' }}>Target Size:</label>
                        <input type="range" min="10" max="80" step="1" value={randomTargetSize} onChange={(e) => updateTargetSize(circleTargetSize, parseInt(e.target.value))} disabled={connectionState !== 'connected'} style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }} />
                        <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{randomTargetSize}px</span>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                        Sum-of-sinusoids trajectory (60s, auto-stops)
                      </div>
                      {randomTargetRunning && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151', padding: '0.25rem 0' }}>
                          <span style={{ fontWeight: '500' }}>Elapsed:</span>
                          <span style={{ fontWeight: '600', color: '#8b5cf6' }}>
                            {Math.floor(randomTargetElapsedTime / 60)}:{(randomTargetElapsedTime % 60).toString().padStart(2, '0')}
                            {' / 1:00'}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Mobile Controls Section (demo) */}
                <div className="ctrl-section">
                  <h4>Mobile Controls</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.875rem', minWidth: '120px' }}>Joystick Multiplier:</label>
                      <input type="range" min="0.1" max="3.0" step="0.1" value={joystickMultiplier} onChange={(e) => updateJoystickMultiplier(parseFloat(e.target.value))} disabled={connectionState !== 'connected'} style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }} />
                      <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{joystickMultiplier.toFixed(1)}x</span>
                    </div>
                    <button
                      type="button"
                      onClick={resetMobileCursorPosition}
                      disabled={connectionState !== 'connected'}
                      style={{ padding: '0.5rem', background: '#f59e0b', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                    >
                      Reset Mobile Cursor Position
                    </button>
                  </div>
                </div>

                {/* Demo Control Panel */}
                <div className="ctrl-section ctrl-section--accent">
                  <h4>Demo Control</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={demoRunning ? stopDemo : startDemo}
                      disabled={connectionState !== 'connected' || isUploading}
                      style={{
                        padding: '0.75rem',
                        background: demoRunning ? '#dc2626' : '#8b5cf6',
                        color: 'white',
                        border: 'none',
                        borderRadius: '0.375rem',
                        fontWeight: '700',
                        fontSize: '1rem',
                        cursor: connectionState === 'connected' && !isUploading ? 'pointer' : 'not-allowed',
                        animation: demoRunning ? 'pulse 2s infinite' : 'none',
                      }}
                    >
                      {demoRunning ? 'Stop' : 'Start'}
                    </button>
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      padding: '0.75rem',
                      background: demoRunning ? '#ede9fe' : '#f3f4f6',
                      borderRadius: '0.375rem', border: '1px solid #d1d5db',
                    }}>
                      <span style={{ fontSize: '0.875rem', color: '#374151' }}>
                        Elapsed Time:{' '}
                        <strong style={{ fontFamily: 'monospace', fontSize: '1.25rem', color: demoRunning ? '#6d28d9' : '#374151' }}>
                          {Math.floor(demoElapsedSeconds / 60).toString().padStart(2, '0')}:{(demoElapsedSeconds % 60).toString().padStart(2, '0')}
                        </strong>
                      </span>
                    </div>
                    {demoRunning && (
                      <div style={{ fontSize: '0.75rem', color: '#6d28d9', textAlign: 'center', fontWeight: '500' }}>
                        Recording in progress (auto-upload on stop)
                      </div>
                    )}
                    {uploadProgress !== null && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#374151' }}>
                          <span style={{ fontWeight: '500' }}>Uploading to Supabase...</span>
                          <span style={{ fontWeight: '600', color: uploadProgress === 100 ? '#10b981' : '#8b5cf6' }}>{uploadProgress}%</span>
                        </div>
                        <div style={{ width: '100%', height: '6px', background: '#e5e7eb', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ width: `${uploadProgress}%`, height: '100%', background: uploadProgress === 100 ? '#10b981' : '#8b5cf6', transition: 'width 0.2s ease' }} />
                        </div>
                        {uploadProgress === 100 && (
                          <span style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: '500' }}>Upload complete!</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Werewolf Panel */}
                <div className="ctrl-section ctrl-section--warn">
                  <h4>Werewolf Cursors</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.875rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={werewolfEnabled}
                        onChange={(e) => setWerewolfEnabled(e.target.checked)}
                        style={{ marginRight: '0.5rem', cursor: 'pointer' }}
                      />
                      Enable Werewolf Cursors
                    </label>
                    {werewolfEnabled && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <label style={{ fontSize: '0.75rem', minWidth: '60px' }}>Count:</label>
                          <input type="range" min="1" max="10" step="1" value={werewolfCount} onChange={(e) => setWerewolfCount(parseInt(e.target.value))} style={{ flex: 1, cursor: 'pointer' }} />
                          <span style={{ fontSize: '0.75rem', minWidth: '24px', textAlign: 'right' }}>{werewolfCount}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <label style={{ fontSize: '0.75rem', minWidth: '60px' }}>Noise:</label>
                          <input type="range" min="0" max="0.2" step="0.005" value={werewolfNoise} onChange={(e) => setWerewolfNoise(parseFloat(e.target.value))} style={{ flex: 1, cursor: 'pointer' }} />
                          <span style={{ fontSize: '0.75rem', minWidth: '40px', textAlign: 'right' }}>{werewolfNoise.toFixed(3)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <label style={{ fontSize: '0.75rem', minWidth: '60px' }}>Speed:</label>
                          <input type="range" min="0.01" max="0.5" step="0.01" value={werewolfSpeed} onChange={(e) => setWerewolfSpeed(parseFloat(e.target.value))} style={{ flex: 1, cursor: 'pointer' }} />
                          <span style={{ fontSize: '0.75rem', minWidth: '40px', textAlign: 'right' }}>{werewolfSpeed.toFixed(2)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <label style={{ fontSize: '0.75rem', minWidth: '60px' }}>Radius:</label>
                          <input type="range" min="0.05" max="0.45" step="0.01" value={werewolfRadius} onChange={(e) => setWerewolfRadius(parseFloat(e.target.value))} style={{ flex: 1, cursor: 'pointer' }} />
                          <span style={{ fontSize: '0.75rem', minWidth: '40px', textAlign: 'right' }}>{werewolfRadius.toFixed(2)}</span>
                        </div>
                        <div style={{ fontSize: '0.7rem', color: '#854d0e', fontStyle: 'italic' }}>
                          Active in: circle-target-tracking, guide-tracking
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Cursor Property (demo) */}
                <div className="ctrl-section">
                  <h4>Cursor Size</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.875rem', minWidth: '140px' }}>Participant Cursor:</label>
                      <input type="range" min="6" max="50" step="1" value={participantCursorSize} onChange={(e) => updateCursorSize(parseInt(e.target.value), averageCursorSize)} disabled={connectionState !== 'connected'} style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }} />
                      <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{participantCursorSize}px</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.875rem', minWidth: '140px' }}>Average Cursor:</label>
                      <input type="range" min="6" max="50" step="1" value={averageCursorSize} onChange={(e) => updateCursorSize(participantCursorSize, parseInt(e.target.value))} disabled={connectionState !== 'connected'} style={{ flex: 1, cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }} />
                      <span style={{ fontSize: '0.875rem', minWidth: '40px', textAlign: 'right' }}>{averageCursorSize}px</span>
                    </div>
                  </div>
                </div>

                {/* Display Settings (demo) */}
                <div className="ctrl-section">
                  <h4>Display</h4>
                  <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                    Participant Display Mode:
                    <select
                      value={displayMode}
                      onChange={(e) => updateDisplayMode(e.target.value as DisplayMode)}
                      disabled={connectionState !== 'connected'}
                      style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }}
                    >
                      <option value="all-without-avg">All Cursors without Avg cursor</option>
                      <option value="all-with-avg-lines">All Cursors and Average Cursor with Lines</option>
                      <option value="all-with-avg-no-lines">All Cursors and Average Cursor without Lines</option>
                      <option value="avgOnly">Average Only</option>
                      <option value="self">Self Only</option>
                      <option value="self-with-avg">Self + Average Cursor</option>
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', fontSize: '0.875rem', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}>
                    <input
                      type="checkbox"
                      checked={hideCursor}
                      onChange={(e) => updateHideCursor(e.target.checked)}
                      disabled={connectionState !== 'connected'}
                      style={{ marginRight: '0.5rem', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                    />
                    Hide Participant Cursor on Stage
                  </label>
                </div>

                {/* Session Control (demo) */}
                <div className="ctrl-section">
                  <h4>Session</h4>
                  <button
                    type="button"
                    onClick={triggerSessionCompletion}
                    disabled={connectionState !== 'connected'}
                    style={{ width: '100%', padding: '0.5rem', background: '#10b981', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                  >
                    End Session
                  </button>
                </div>
            </>)}
          </aside>
        )}
        {isAdmin && (
          <div className="resize-handle" onMouseDown={(e) => handleResizeStart('left', e)} />
        )}

        <div className={isAdmin ? "admin-center" : ""}>
          <div className="stage-wrapper">
            <div className="stage-area">
            <div
              ref={stageRef}
              className={`stage${shouldHideNativeCursorOnStage ? ' hide-cursor' : ''}`}
              onPointerMove={handlePointerEvent}
              onPointerDown={handlePointerEvent}
              onPointerEnter={handlePointerEnterStage}
              onPointerLeave={handlePointerLeave}
            >
          {/* All visual stage elements (cursors, averages, lines, target,
              guide, yes/no areas) are rendered by p5.js inside <TaskStage>.
              The active TaskMode drives which per-task experiment sketch
              draws on top of the common base scene (see
              `experiments/registry.ts`). Interactive overlays
              (click-area-lock, broadcast messages, top hint, inactive
              prompt) remain DOM children below. */}
          <TaskStage
            taskMode={taskMode}
            experimentTaskType={experimentTaskType}
            cursors={p5StageCursors}
            averages={p5StageAverages}
            lines={p5StageLines}
            target={p5StageTarget}
            guide={p5StageGuide}
            yesNo={p5StageYesNo}
          />
          {sharedQuestionnaire.visible && !isAdmin && (
            <div className={`shared-questionnaire${showTask9QuestionnaireScore ? ' shared-questionnaire--task9-score' : ''}`}>
              {showTask9QuestionnaireScore && (
                <div className="task9-shared-questionnaire-score">
                  Score: {task9Score?.score ?? 0}
                </div>
              )}
              <div
                className="shared-questionnaire__panel"
                style={sharedQuestionnaire.kind === 'contribution'
                  ? { width: `min(100%, ${SHARED_CONTRIBUTION_PANEL_MAX_WIDTH_PX}px)` }
                  : undefined}
              >
                {sharedQuestionnaire.kind === 'contribution' ? (
                  <SharedContributionQuestion
                    question={getSharedContributionQuestion(experimentTaskType)}
                    value={sharedQuestionnaire.contribution}
                    onChange={(value) => setSharedQuestionnaire((prev) => ({ ...prev, contribution: value }))}
                  />
                ) : (
                  <>
                    <SharedQuestion
                      question={<>How much control did you feel you had over the cursor <strong><em>yourself</em></strong>?</>}
                      value={sharedQuestionnaire.agency}
                      onChange={(value) => setSharedQuestionnaire((prev) => ({ ...prev, agency: value }))}
                    />
                    <SharedQuestion
                      question={<>How much control did you feel you had over the cursor <strong><em>together with your partner</em></strong>?</>}
                      value={sharedQuestionnaire.partnership}
                      onChange={(value) => setSharedQuestionnaire((prev) => ({ ...prev, partnership: value }))}
                    />
                  </>
                )}
                {(sharedQuestionnaire.kind === 'contribution'
                  ? isSharedContributionSelected(sharedQuestionnaire.contribution)
                  : sharedQuestionnaire.agency !== null && sharedQuestionnaire.partnership !== null)
                  && !sharedQuestionnaire.submitted && (
                  <button
                    type="button"
                    className="shared-questionnaire__next"
                    onClick={submitSharedQuestionnaire}
                    disabled={sharedQuestionnaire.submitting}
                  >
                    {sharedQuestionnaire.submitting
                      ? 'Submitting...'
                      : sharedQuestionnaire.kind === 'contribution'
                        ? SHARED_CONTRIBUTION_SUBMIT_LABEL
                        : 'Next'}
                  </button>
                )}
                {sharedQuestionnaire.submitted && (
                  <div className="shared-questionnaire__submitted">
                    Waiting for the next trial...
                  </div>
                )}
              </div>
            </div>
          )}
          {sharedQuestionnaireWaiting
            && !sharedQuestionnaire.visible
            && !isAdmin
            && !(taskMode === 'shared-single-cursor' && sharedCursorControl.enabled && sharedDisturbanceStartedAt !== null) && (
            <div className="shared-questionnaire-wait">
              <div className="shared-questionnaire-wait__text">
                Waiting for the other participant...
              </div>
            </div>
          )}
          {taskMode === 'target-tracking' && !isAdmin && (
            <div
              style={{
                position: 'absolute',
                top: '12px',
                left: '50%',
                transform: 'translateX(-50%)',
                color: 'black',
                fontSize: '1rem',
                fontWeight: 'normal',
                zIndex: 1000,
                pointerEvents: 'none',
              }}
            >
              Please keep tracking the target.
            </div>
          )}
          {broadcastMessages.filter((m) => m.position !== 'bottom').map((msg) => (
            <div
              key={msg.id}
              style={{
                position: 'absolute',
                ...(msg.position === 'top' ? {
                  top: '12px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                } : {
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                }),
                background: msg.position === 'top' ? 'transparent'
                  : msg.severity === 'error' ? 'rgba(220, 38, 38, 0.5)' : msg.severity === 'warning' ? 'rgba(245, 158, 11, 0.5)' : 'rgba(59, 130, 246, 0.5)',
                color: msg.position === 'top' ? '#374151' : 'white',
                padding: msg.position === 'top' ? '0.25rem 0.75rem' : '1rem 2rem',
                borderRadius: '0.5rem',
                fontSize: msg.position === 'top' ? '0.85rem' : '2.5rem',
                fontWeight: msg.position === 'top' ? '500' : 'bold',
                whiteSpace: msg.position === 'top' ? 'pre-line' : undefined,
                zIndex: 2500,
                pointerEvents: 'none',
                textAlign: 'center',
                maxWidth: '90%',
              }}
          >
              {msg.text}
            </div>
          ))}
          {broadcastMessages.filter((m) => m.position === 'bottom').map((msg) => (
            <StageBottomInstruction
              key={msg.id}
              message={msg}
              isAdmin={isAdmin}
              identity={localIdentityRef.current}
              tokenServerUrl={tokenServerUrl}
              onRequestPointerLock={() => stageRef.current?.requestPointerLock()}
              isPointerLocked={isPointerLocked}
              allParticipantsPointerLocked={allParticipantsPointerLocked}
              suppressLockWaitMessage={!isAdmin && isCursorControlTask && taskMode === 'shared-single-cursor'}
              experimentTaskType={experimentTaskType}
            />
          ))}
          {showTask9CompletionScore && (
            <div
              className="task9-completion-score"
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#16a34a',
                fontSize: '72px',
                fontWeight: 'bold',
                zIndex: 2500,
                pointerEvents: 'none',
                textAlign: 'center',
              }}
            >
              Score: {task9Score?.score ?? 0}
            </div>
          )}
          {showInitialWorkspaceHint && (
            <>
              {showTask7InitialWorkspaceHint ? (
                <div className="stage-initial-workspace-top-hint">
                  {PARTICIPANT_WAITING_CURSOR_NOTICE}
                </div>
              ) : (
                <div className="stage-initial-workspace-top-hint">
                  While your cursor is inside the target, the target changes from red to green.
                </div>
              )}
              <div className={`stage-initial-workspace-hint${realParticipantConnectionCount < 2 ? ' waiting' : ' ready'}`}>
                {getParticipantStartPrompt(
                  realParticipantConnectionCount,
                  participantStartClicked,
                  participantStartError,
                )}
              </div>
              {showTask7InitialWorkspaceHint && realParticipantConnectionCount >= 2 && (
                <button
                  type="button"
                  className="task7-start-button"
                  onClick={handleParticipantStartClick}
                  disabled={participantStartRequestPending || participantStartClicked}
                >
                  {getParticipantStartButtonLabel(participantStartClicked, participantStartRequestPending)}
                </button>
              )}
            </>
          )}
          {error && <div className="toast">{error}</div>}
          {isInactive && !isAdmin && taskMode !== 'manual-instruction' && taskMode !== 'shared-single-cursor' && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background: 'rgba(245, 158, 11, 0.6)',
                color: 'white',
                padding: '2rem 3rem',
                borderRadius: '1rem',
                fontSize: '1.5rem',
                fontWeight: 'bold',
                textAlign: 'center',
                zIndex: 2000,
                pointerEvents: 'none',
                maxWidth: '80%',
              }}
            >
              Please move your cursor to continue
            </div>
          )}
          {/*
            Cursor-lock overlay. Shown whenever the virtual-cursor mode is on
            (`useVirtualCursor === true`, i.e. the agent has reached the lock
            instruction) and the participant has not yet locked
            (`!isPointerLocked`). It auto-disappears the moment the participant
            locks, and reappears if they press Esc and lose the lock — the
            previous gating used the agent-controlled `showClickAreaOverlay`,
            which was switched off mid-instruction-flow and stranded
            participants who hadn't locked yet without a way back. Admin and
            already-locked participants don't see it.
          */}
          {useVirtualCursor
            && !showTask7InitialWorkspaceHint
            && (taskMode !== 'shared-single-cursor' || task7PointerLockRecoveryRequired)
            && !broadcastMessages.some((message) => message.waitForNext && (message.instructionPages?.length ?? 0) > 0)
            && !isAdmin
            && !isPointerLocked && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 3000,
              }}
            >
              {task7PointerLockRecoveryRequired && (
                <div
                  style={{
                    background: '#111827',
                    color: 'white',
                    padding: '0.75rem 1rem',
                    borderRadius: '0.5rem',
                    fontSize: '1rem',
                    fontWeight: 'bold',
                    textAlign: 'center',
                    maxWidth: '340px',
                    marginBottom: '1rem',
                  }}
                >
                  Please do not press the Esc key during the experiment.
                </div>
              )}
              <div
                onClick={() => {
                  stageRef.current?.requestPointerLock();
                }}
                style={{
                  width: '150px',
                  height: '150px',
                  borderRadius: '50%',
                  border: '4px dashed #3b82f6',
                  background: 'rgba(59, 130, 246, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '1rem',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: '#3b82f6',
                  }}
                />
              </div>
              <div
                style={{
                  background: 'rgba(59, 130, 246, 0.9)',
                  color: 'white',
                  padding: '1rem 1.5rem',
                  borderRadius: '0.5rem',
                  fontSize: '1.1rem',
                  fontWeight: 'bold',
                  textAlign: 'center',
                  maxWidth: '300px',
                  pointerEvents: 'none',
                }}
              >
                {task7PointerLockRecoveryRequired
                  ? 'Click the center of the circle above to switch back to the task cursor.'
                  : 'Click in the center of this area to lock your cursor for virtual cursor mode'}
              </div>
            </div>
          )}
            </div>
            </div>
            {/* Task-specific controls below the stage (experiment mode) */}
            {isAdmin && adminMode === 'experiment' && (
              <div className="admin-task-settings">
                {taskMode === 'circle-target-tracking' && (
                  <div className="ctrl-section">
                    <h4>Circle Target</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          onClick={startCircleTarget}
                          disabled={connectionState !== 'connected' || circleTargetRunning}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: circleTargetRunning ? '#9ca3af' : '#22c55e',
                            color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500',
                            cursor: connectionState === 'connected' && !circleTargetRunning ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Start
                        </button>
                        <button
                          type="button"
                          onClick={resetCircleTarget}
                          disabled={connectionState !== 'connected'}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: '#ef4444', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500',
                            cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Reset
                        </button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem', background: circleTargetRunning ? '#dbeafe' : '#f3f4f6', borderRadius: '0.375rem', border: '1px solid #d1d5db' }}>
                        <span style={{ fontSize: '0.875rem', color: '#374151' }}>
                          Elapsed Time: <strong style={{ fontFamily: 'monospace', fontSize: '1rem' }}>{circleTargetElapsedTime}s</strong>
                        </span>
                      </div>
                      <label style={{ display: 'block', fontSize: '0.875rem' }}>
                        Period (ms):
                        <input type="number" value={circleTargetPeriod} onChange={(e) => setCircleTargetPeriod(Number(e.target.value))} min="1000" max="30000" step="100" disabled={connectionState !== 'connected' || circleTargetRunning} style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }} />
                      </label>
                      <label style={{ display: 'block', fontSize: '0.875rem' }}>
                        Circle Radius (0-0.5):
                        <input type="number" value={circleTargetRadius} onChange={(e) => setCircleTargetRadius(Number(e.target.value))} min="0.1" max="0.5" step="0.01" disabled={connectionState !== 'connected' || circleTargetRunning} style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }} />
                      </label>
                      <label style={{ display: 'block', fontSize: '0.875rem' }}>
                        Display Duration (seconds):
                        <input type="number" value={circleTargetDuration / 1000} onChange={(e) => setCircleTargetDuration(Number(e.target.value) * 1000)} min="1" max="300" step="1" disabled={connectionState !== 'connected' || circleTargetRunning} style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '0.375rem', border: '1px solid #d1d5db' }} />
                      </label>
                    </div>
                  </div>
                )}

                {taskMode === 'guide-tracking' && (
                  <div className="ctrl-section">
                    <h4>Guide Tracking</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          onClick={startGuideTracking}
                          disabled={connectionState !== 'connected' || guideTrackingRunning}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: guideTrackingRunning ? '#9ca3af' : '#22c55e',
                            color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500',
                            cursor: connectionState === 'connected' && !guideTrackingRunning ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Start
                        </button>
                        <button
                          type="button"
                          onClick={resetGuideTracking}
                          disabled={connectionState !== 'connected'}
                          style={{
                            flex: 1, padding: '0.5rem',
                            background: '#ef4444', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500',
                            cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
                          }}
                        >
                          Reset
                        </button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.5rem', background: guideTrackingRunning ? '#dbeafe' : '#f3f4f6', borderRadius: '0.375rem', border: '1px solid #d1d5db' }}>
                        <span style={{ fontSize: '0.875rem', color: '#374151' }}>
                          Elapsed: <strong style={{ fontFamily: 'monospace', fontSize: '1rem' }}>{guideTrackingElapsedTime}s</strong>
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {taskMode === 'manual-instruction' && (
                  <div className="ctrl-section">
                    <h4>Yes/No Areas</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <button
                        type="button"
                        onClick={showYesNoAreas}
                        disabled={connectionState !== 'connected'}
                        style={{ padding: '0.5rem', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed' }}
                      >
                        Show Yes/No Areas
                      </button>
                      <button
                        type="button"
                        onClick={hideYesNoAreas}
                        disabled={connectionState !== 'connected' || !yesNoAreas.visible}
                        style={{ padding: '0.5rem', background: yesNoAreas.visible ? '#ef4444' : '#9ca3af', color: 'white', border: 'none', borderRadius: '0.375rem', fontWeight: '500', cursor: connectionState === 'connected' && yesNoAreas.visible ? 'pointer' : 'not-allowed' }}
                      >
                        Hide Yes/No Areas
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {isAdmin && chatMessages.length > 0 && (
              <div className="admin-chat-panel">
                <h3>Participant Messages</h3>
                <div className="chat-messages">
                  {chatMessages.map((msg) => (
                    <div key={msg.id} className="chat-message">
                      <div className="chat-message-header">
                        <strong>{msg.from}</strong>
                        <span className="chat-timestamp">
                          {new Date(msg.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="chat-message-text">{msg.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {isAdmin && adminMode === 'experiment' && (
              <DatabaseAdmin embedded refreshKey={recordingDatabaseRefreshKey} />
            )}
          </div>
        </div>
        {isAdmin && (
          <div className="resize-handle" onMouseDown={(e) => handleResizeStart('right', e)} />
        )}
        {isAdmin && (
          <aside className="admin-sidebar" style={{ flex: `0 0 ${rightPanelWidth}px` }}>
            <div className="participant-list-panel">
              <h3>Participants ({realLiveKitParticipants.length})</h3>
              <div className="participant-list-entries">
                {realLiveKitParticipants.length === 0 ? (
                  <div className="participant-entry-empty">No participants connected</div>
                ) : (
                                    realLiveKitParticipants.map((participant, index) => {
                                      const cursor = cursorsRef.current.get(participant.identity);
                                      const rttMs = latencyByIdentity.get(participant.identity);
                                      const participantStatus = participantStatusByIdentity.get(participant.identity);
                                      const hasActiveCursor = cursor && (Date.now() - cursor.updatedAt) < STALE_CURSOR_MS;
                                      const isOnStage = hasActiveCursor;
                                      const cursorColor = cursor ? cursor.color : colorFromIdentity(participant.identity);
                                      const isLocalParticipant = cursor?.isLocal || false;
                                      const isLocked = participantStatus?.isPointerLocked ?? false;
                                      const isUsingVirtual = participantStatus?.isUsingVirtualCursor ?? false;
                    
                                      return (
                                        <div key={participant.identity} className="participant-entry">
                                          <div className="participant-info">
                                            <span className="participant-index">#{index + 1}</span>
                                            <div
                                              className="participant-color-indicator"
                                              style={{ background: cursorColor }}
                                            />
                                            <div className="participant-details">
                                              <span className="participant-name">
                                                {participant.displayName}
                                                {isLocalParticipant && (
                                                  <span className="participant-badge"> (You)</span>
                                                )}
                                              </span>
                                              <span className="participant-identity">
                                                {participant.identity}
                                              </span>
                                            </div>
                                          </div>
                                          <div className="participant-stats">
                                            <div className="participant-cursor-status" style={{ display: 'flex', gap: '4px', marginRight: '8px' }}>
                                              <span
                                                style={{
                                                  fontSize: '0.7rem',
                                                  padding: '1px 4px',
                                                  borderRadius: '3px',
                                                  background: isLocked ? '#3b82f6' : '#e5e7eb',
                                                  color: isLocked ? '#fff' : '#9ca3af',
                                                  fontWeight: isLocked ? 'bold' : 'normal',
                                                }}
                                                title={isLocked ? 'Pointer Locked' : 'Pointer Not Locked'}
                                              >
                                                Lock
                                              </span>
                                              <span
                                                style={{
                                                  fontSize: '0.7rem',
                                                  padding: '1px 4px',
                                                  borderRadius: '3px',
                                                  background: isUsingVirtual ? '#8b5cf6' : '#e5e7eb',
                                                  color: isUsingVirtual ? '#fff' : '#9ca3af',
                                                  fontWeight: isUsingVirtual ? 'bold' : 'normal',
                                                }}
                                                title={isUsingVirtual ? 'Using Virtual Cursor' : 'Not Using Virtual Cursor'}
                                              >
                                                Virtual
                                              </span>
                                            </div>
                                            <div className="participant-rtt">
                                              {rttMs !== undefined && rttMs !== null ? (
                                                <span
                                                  className="rtt-value"
                                                  style={{
                                                    color: rttMs < 50 ? '#10b981' : rttMs < 150 ? '#f59e0b' : '#dc2626',
                                                    fontWeight: 'bold',
                                                  }}
                                                >
                                                  {rttMs}ms
                                                </span>
                                              ) : (
                                                <span className="rtt-value" style={{ color: '#9ca3af' }}>
                                                  --
                                                </span>
                                              )}
                                            </div>
                                            <div className="participant-status">
                                              <span
                                                className="status-indicator"
                                                style={{
                                                  background: isOnStage ? '#10b981' : '#dc2626',
                                                }}
                                                title={isOnStage ? 'On Stage (Sending Cursor Data)' : 'In Session (Not on Stage)'}
                                              />
                                            </div>
                                            {!isLocalParticipant && !participant.identity.startsWith('admin:') && (
                                              <button
                                                className="kick-button"
                                                onClick={() => kickParticipant(participant.identity)}
                                                title="Remove participant from experiment"
                                              >
                                                KICK
                                              </button>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })
                )}
              </div>
            </div>
            <div className="participant-log-panel">
              <h3>Participant Log</h3>
              <div className="participant-log-entries">
                {participantLog.length === 0 ? (
                  <div className="log-entry-empty">No participant events yet</div>
                ) : (
                  participantLog.map((event) => (
                    <div key={event.id} className={`log-entry log-entry-${event.eventType}`}>
                      <span className="log-timestamp">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="log-event-type">
                        {event.eventType === 'joined' ? 'Joined' : 'Left'}
                      </span>
                      <span className="log-display-name">{event.displayName}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
