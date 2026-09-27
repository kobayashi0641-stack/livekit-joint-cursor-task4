/**
 * Experiment registry — single source of truth for which tasks exist and how
 * the agent assembles a full rule sequence from a config.
 *
 * To add a new experiment task:
 *   1. Create `experiments/<task-id>/` with `instructions.ts`, `experiment.ts`,
 *      and `index.ts` (export an `ExperimentTask`).
 *   2. Add the new task type to `ExperimentTaskType` in `agent-rules.ts`.
 *   3. Register it in `taskRegistry` below.
 */

import type {
  AgentRule,
  ExperimentConfig,
  ExperimentTaskType,
} from '../agent-rules.js';
import { DEFAULT_EXPERIMENT_CONFIG, isCursorControlExperimentTask, isSharedSingleCursorExperimentTask } from '../agent-rules.js';
import { formatTimestampForFilename } from '../time.js';

import {
  buildExecuteTrialRule,
  generateCommonInstructions,
  generateFinalInstructions,
  generateWaitPhase,
  wrapTaskInstructionText,
} from './common-flow.js';
import type { ExperimentTask } from './types.js';

import { circleTargetTrackingTask } from './circle-target-tracking/index.js';
import { guideTrackingTask } from './guide-tracking/index.js';
import { nonGuideTrackingTask } from './non-guide-tracking/index.js';
import { groupCircleTargetTrackingTask } from './group-circle-target-tracking/index.js';
import { reachingTask } from './reaching/index.js';
import { sharedSingleCursorControlTask } from './shared-single-cursor-control/index.js';
import { cursorControl20260706Task } from './cursor-control-20260706/index.js';
import { task8Task } from './task8/index.js';
import { task9Task } from './task9/index.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const taskRegistry: Record<ExperimentTaskType, ExperimentTask> = {
  'circle-target-tracking': circleTargetTrackingTask,
  'guide-tracking': guideTrackingTask,
  'non-guide-tracking': nonGuideTrackingTask,
  'group-circle-target-tracking': groupCircleTargetTrackingTask,
  'reaching': reachingTask,
  'shared-single-cursor-control': sharedSingleCursorControlTask,
  'cursor-control-20260706': cursorControl20260706Task,
  'task8': task8Task,
  'task9': task9Task,
};

export function getTask(type: ExperimentTaskType): ExperimentTask {
  const task = taskRegistry[type];
  if (!task) {
    throw new Error(`Unknown experiment task type: ${type}`);
  }
  return task;
}

export const allTasks: ExperimentTask[] = Object.values(taskRegistry);

export type { ExperimentTask, TrialContext } from './types.js';

// ---------------------------------------------------------------------------
// Rule generation
// ---------------------------------------------------------------------------

/** Build the default experiment_name when the operator left it blank. */
function defaultExperimentName(config: ExperimentConfig): string {
  const ts = formatTimestampForFilename(Date.now());
  return `${config.taskType}_N${config.minParticipants}_${ts}`;
}

function generateSharedSingleCursorRules(config: ExperimentConfig, task: ExperimentTask): AgentRule[] {
  const dur = config.instructionDurationMs;
  const experimentName = config.experimentName || `${task.type}_N2_${formatTimestampForFilename(Date.now())}`;
  const usesParticipantStartGate = config.taskType === 'cursor-control-20260706' || config.taskType === 'task9';

  return [
    { type: 'setCursorVisibility', hideCursor: false },
    { type: 'hideYesNoAreas' },
    {
      type: 'waitForParticipants',
      minParticipants: 2,
      timeoutMinutes: usesParticipantStartGate ? 5 : config.waitTimeMinutes,
      waitPhaseDisplayMode: 'self',
      waitPhaseTaskMode: 'manual-instruction',
      waitPhaseHideCursor: false,
      showCountdown: false,
      waitIndefinitely: !usesParticipantStartGate,
      ...(usesParticipantStartGate ? { endOnTimeout: true } : {}),
      waitForAdminStart: isCursorControlExperimentTask(config.taskType) && !usesParticipantStartGate,
      ...(usesParticipantStartGate
        ? { waitForParticipantStart: true, participantStartTimeoutSeconds: 120 }
        : {}),
      ...(isCursorControlExperimentTask(config.taskType) ? {} : { alternatingMessages: {
        messages: [
          'Waiting for the other participant...\nThe task will start once both participants are connected.',
        ],
        intervalMs: 5000,
      } }),
    },
    {
      type: 'showInstruction' as const,
      text: task.generateInstructions(config)[0],
      instructionPages: task.generateInstructions(config),
      durationMs: dur,
      broadcastDurationMs: 60 * 60 * 1000,
      waitForDuration: false,
      waitForNext: true,
      nextMinDisplayMs: 1000,
      displayMode: 'self' as const,
      position: 'bottom' as const,
    },
    { type: 'enableVirtualCursor', timeoutSeconds: 0 },
    { type: 'setClickAreaOverlay', show: false },
    { type: 'wait', durationSeconds: 2 },
    { type: 'setTaskMode', taskMode: task.liveKitTaskMode },
    ...(task.generateTrialSequence
      ? task.generateTrialSequence(config, experimentName)
      : Array.from({ length: config.trialCount }, (_, i) =>
          buildExecuteTrialRule(config, experimentName, i + 1, config.trialCount),
        )),
    ...generateFinalInstructions(config),
  ];
}

export function generateRulesFromConfig(config: ExperimentConfig): AgentRule[] {
  const task = getTask(config.taskType);
  const dur = config.instructionDurationMs;
  const experimentName = config.experimentName || defaultExperimentName(config);

  if (isSharedSingleCursorExperimentTask(config.taskType)) {
    return generateSharedSingleCursorRules(config, task);
  }

  const rules: AgentRule[] = [
    // ── Wait phase ───────────────────────────────────────────────
    ...generateWaitPhase(config),

    // ── Common 11 instructions ───────────────────────────────────
    ...generateCommonInstructions(config),

    // ── Task-specific instructions ───────────────────────────────
    ...task.generateInstructions(config).flatMap((text) => wrapTaskInstructionText(text, dur)),

    // ── Pre-trial 5-second wait + set the LiveKit task mode ──────
    { type: 'wait', durationSeconds: 5 },
    { type: 'setTaskMode', taskMode: task.liveKitTaskMode },

    // ── Trial loop (task may override) ───────────────────────────
    ...(task.generateTrialSequence
      ? task.generateTrialSequence(config, experimentName)
      : Array.from({ length: config.trialCount }, (_, i) =>
          buildExecuteTrialRule(config, experimentName, i + 1, config.trialCount),
        )),

    // ── Final instructions + endSession ──────────────────────────
    ...generateFinalInstructions(config),
  ];

  return rules;
}

/** Default rule sequence (using DEFAULT_EXPERIMENT_CONFIG). Used by ExperimentAgent on construction. */
export const DEFAULT_RULES: AgentRule[] = generateRulesFromConfig(DEFAULT_EXPERIMENT_CONFIG);
