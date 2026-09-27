/**
 * Task-independent rule fragments used by every experiment:
 *   - Wait phase (waitForParticipants + alternating messages + triangle target tracking)
 *   - Common 11 instructions shown to all participants before any task-specific content
 *   - Final instructions ("All trials complete" → "Thank you" → redirect → endSession)
 *
 * The task-specific portions (per-task instructions + trial body) live in
 * `experiments/<task-id>/`.
 */

import type {
  AgentRule,
  DisplayMode,
  ExecuteTrialRule,
  ExperimentConfig,
} from '../agent-rules.js';
import { isCursorControlExperimentTask, isSharedSingleCursorExperimentTask } from '../agent-rules.js';

/**
 * Yes/No confirmation timeout (seconds) used after every wrapped instruction.
 * Also feeds the broadcast lifetime calculation so the instruction text stays
 * on screen across the entire Yes/No phase that immediately follows it.
 */
const INSTRUCTION_YES_NO_TIMEOUT_SECONDS = 6;
/**
 * Extra buffer (ms) on the broadcast lifetime, so the instruction is still
 * visible during the brief moment between `hideYesNoAreas` and the next
 * `showInstruction` (and to absorb network jitter).
 */
const INSTRUCTION_BROADCAST_BUFFER_MS = 2000;

/**
 * Wrap a single instruction text with a Yes/No confirmation pair.
 * Used by both common instructions and task-specific instructions.
 *
 * The broadcast lifetime is extended past the agent's sleep (read time) to
 * cover the Yes/No phase, so the instruction text remains on screen while
 * participants tap Yes. The next instruction's broadcast will replace this
 * one on clients (see `App.tsx → handleBroadcastMessage`, which dismisses
 * any existing broadcast in the same slot when a new one arrives).
 */
export function wrapInstructionWithYesNo(
  rule: Extract<AgentRule, { type: 'showInstruction' }>,
): AgentRule[] {
  const broadcastDurationMs =
    rule.durationMs +
    INSTRUCTION_YES_NO_TIMEOUT_SECONDS * 1000 +
    INSTRUCTION_BROADCAST_BUFFER_MS;
  return [
    { ...rule, broadcastDurationMs },
    {
      type: 'showYesNoAreas',
      requiredArea: 'yes',
      requiredRatio: 1.0,
      timeoutSeconds: INSTRUCTION_YES_NO_TIMEOUT_SECONDS,
    },
    { type: 'hideYesNoAreas' },
  ];
}

/** Wrap a plain text into a task-style instruction (self display, bottom position) + Yes/No. */
export function wrapTaskInstructionText(text: string, durationMs: number): AgentRule[] {
  return wrapInstructionWithYesNo({
    type: 'showInstruction',
    text,
    durationMs,
    waitForDuration: true,
    displayMode: 'self',
    position: 'bottom',
  });
}

/**
 * Build a single `executeTrial` rule using the experiment config. Used by both
 * the default trial loop (in `experiments/index.ts`) and any task that
 * provides a custom `generateTrialSequence`.
 */
export function buildExecuteTrialRule(
  config: ExperimentConfig,
  experimentName: string,
  trialNumber: number,
  totalTrials: number,
): ExecuteTrialRule {
  return {
    type: 'executeTrial',
    trialNumber,
    totalTrials,
    durationSeconds: config.trialDurationSeconds,
    taskType: config.taskType,
    experimentName,
    circleTargetPeriod: config.circleTargetPeriod,
    circleTargetRadius: config.circleTargetRadius,
    displayMode: config.trialDisplayMode,
  };
}

/** Wait-phase target on/off cycle: target visible for 30s, then 15s rest, repeating. */
const WAIT_PHASE_TARGET_ACTIVE_MS = 30000;
const WAIT_PHASE_TARGET_REST_MS = 15000;

/** Generate the wait phase: cursor visibility on, waitForParticipants, then stop tracking. */
export function generateWaitPhase(config: ExperimentConfig): AgentRule[] {
  return [
    { type: 'setCursorVisibility', hideCursor: false },
    {
      type: 'waitForParticipants',
      minParticipants: config.minParticipants,
      timeoutMinutes: config.waitTimeMinutes,
      waitPhaseDisplayMode: 'self',
      waitPhaseTaskMode: 'target-tracking',
      waitPhaseHideCursor: false,
      alternatingMessages: {
        messages: [
          'We are waiting for other participants to join. The experiment will begin in a few minutes.',
          'Until the main task begins, please continue moving your cursor to the triangular targets appearing on the screen.',
        ],
        intervalMs: 5000,
      },
      targetCycleActiveMs: WAIT_PHASE_TARGET_ACTIVE_MS,
      targetCycleRestMs: WAIT_PHASE_TARGET_REST_MS,
      restMessage: 'Please rest your hand briefly. The targets will reappear in a moment.',
    },
    // Stop target tracking once enough participants have joined
    { type: 'setTaskMode', taskMode: 'manual-instruction' },
  ];
}

type CommonInstruction = {
  text: string;
  displayMode: DisplayMode;
  setClickAreaOverlay?: boolean;
  setUseVirtualCursor?: boolean;
};

/**
 * Describe what cursors will be visible during the upcoming task — used as the
 * text of the "step 10" common instruction. Adapts to the trial display mode.
 */
function describeUpcomingTaskDisplay(mode: DisplayMode): string {
  switch (mode) {
    case 'avgOnly':
      return 'In the upcoming task, only this Average Cursor will be displayed.';
    case 'self-with-avg':
      return 'In the upcoming task, your own cursor and the Average Cursor will be displayed.';
    case 'self':
      return 'In the upcoming task, only your own cursor will be displayed.';
    case 'all-without-avg':
      return "In the upcoming task, all participants' cursors will be displayed (the Average Cursor will be hidden).";
    case 'all-with-avg-no-lines':
    case 'all-with-avg-lines':
      return "In the upcoming task, all participants' cursors and the Average Cursor will be displayed.";
  }
}

/**
 * Final "step 11" instruction — describes the transition to the trial display
 * state. Each branch ends with the explicit set of cursors that will be visible.
 */
function describePreTaskTransition(mode: DisplayMode): string {
  switch (mode) {
    case 'avgOnly':
      return "We will now hide the Average Cursor and the other participants' cursors. Only the Average Cursor will be visible during the task.";
    case 'self-with-avg':
      return "We will now hide the other participants' cursors. Your own cursor and the Average Cursor will remain visible during the task.";
    case 'self':
      return "We will now hide everyone else's cursors and the Average Cursor. Only your own cursor will be visible during the task.";
    case 'all-without-avg':
      return "We will now hide the Average Cursor. All participants' cursors (without the Average Cursor) will be visible during the task.";
    case 'all-with-avg-no-lines':
    case 'all-with-avg-lines':
      return "All participants' cursors and the Average Cursor will remain visible during the task.";
  }
}

/**
 * Display mode used *during* the step-11 instruction. Must keep the
 * participant's own cursor visible so they can move into the Yes/No area for
 * confirmation. For modes that hide own cursor (`'avgOnly'`), we fall back to
 * `'self'`; otherwise we mirror the trial mode so participants preview what
 * they'll see during the task.
 */
function preTaskInstructionDisplayMode(mode: DisplayMode): DisplayMode {
  return mode === 'avgOnly' ? 'self' : mode;
}

/** The 11 common instructions shown to participants before any task-specific content. */
function buildCommonInstructions(config: ExperimentConfig): CommonInstruction[] {
  const trialMode: DisplayMode = config.trialDisplayMode ?? 'avgOnly';
  return [
    { text: 'Thank you for your participation. The main task will now begin.', displayMode: 'self' },
    { text: 'Your cursor is now visible.', displayMode: 'self' },
    { text: 'We need to switch your cursor to the virtual cursor used for this experiment.', displayMode: 'self' },
    {
      text: 'Please click the center of the screen. Your system pointer will be locked, and it will switch to the virtual cursor within the experimental area.',
      displayMode: 'self',
      setClickAreaOverlay: true,
      setUseVirtualCursor: true,
    },
    {
      text: 'Pressing the Esc key will unlock the pointer, so please do not press it during the experiment.',
      displayMode: 'self',
      setClickAreaOverlay: true,
    },
    {
      text: 'After the end of experiment, your system pointer will be back.',
      displayMode: 'self',
      setClickAreaOverlay: false,
    },
    {
      text: "The cursor of other participants will now be displayed on the screen. Can you see other participants' cursors?",
      displayMode: 'all-without-avg',
    },
    {
      text: 'Next we will display the "Average Cursor" to be used in the experiment.',
      displayMode: 'all-with-avg-no-lines',
    },
    {
      text: "The Average Cursor represents the mean position of all participants' cursors.",
      displayMode: 'all-with-avg-no-lines',
    },
    {
      // Step 10 — describes what will be visible during the task.
      text: describeUpcomingTaskDisplay(trialMode),
      displayMode: 'all-with-avg-no-lines',
    },
    {
      // Step 11 — preview the trial display state (kept own-cursor visible for Yes/No interaction).
      text: describePreTaskTransition(trialMode),
      displayMode: preTaskInstructionDisplayMode(trialMode),
    },
  ];
}

/** Generate the 11 common instructions, each followed by a Yes/No confirmation pair. */
export function generateCommonInstructions(config: ExperimentConfig): AgentRule[] {
  const dur = config.instructionDurationMs;
  return buildCommonInstructions(config).flatMap((instr) =>
    wrapInstructionWithYesNo({
      type: 'showInstruction',
      text: instr.text,
      durationMs: dur,
      waitForDuration: true,
      displayMode: instr.displayMode,
      position: 'bottom',
      setClickAreaOverlay: instr.setClickAreaOverlay,
      setUseVirtualCursor: instr.setUseVirtualCursor,
    }),
  );
}

/** Generate the final 3 instructions + endSession. */
export function generateFinalInstructions(config: ExperimentConfig): AgentRule[] {
  const dur = config.instructionDurationMs;
  if (isCursorControlExperimentTask(config.taskType)) {
    return [
      {
        type: 'showInstruction',
        text: 'The experiment ends. Thank you for your participation.',
        durationMs: 3000,
        waitForDuration: true,
        displayMode: 'all-without-avg',
        position: 'bottom',
      },
      {
        type: 'showInstruction',
        text: 'You will now be redirected to the reward page in a few seconds.',
        durationMs: 3000,
        waitForDuration: true,
        position: 'bottom',
      },
      { type: 'endSession' },
    ];
  }
  if (isSharedSingleCursorExperimentTask(config.taskType)) {
    return [
      {
        type: 'showInstruction',
        text: 'The experiment ends. Thank you for your participation.',
        durationMs: dur,
        waitForDuration: true,
        displayMode: 'all-without-avg',
        position: 'bottom',
      },
      {
        type: 'showInstruction',
        text: 'You will now be redirected to the reward page.',
        durationMs: 5000,
        waitForDuration: true,
        position: 'bottom',
      },
      { type: 'endSession' },
    ];
  }
  return [
    {
      type: 'showInstruction',
      text: 'All trials are now complete.',
      durationMs: dur,
      waitForDuration: true,
      position: 'bottom',
    },
    {
      type: 'showInstruction',
      text: 'The experiment ends. Thank you for your participation.',
      durationMs: dur,
      waitForDuration: true,
      displayMode: 'all-without-avg',
      position: 'bottom',
    },
    {
      type: 'showInstruction',
      text: 'You will now be redirected to the reward page.',
      durationMs: 5000,
      waitForDuration: true,
      position: 'bottom',
    },
    { type: 'endSession' },
  ];
}
