import type { ExperimentTaskType, TaskMode, TaskSketch } from './types';

import circleTargetTracking from './circle-target-tracking/sketch';
import guideTracking from './guide-tracking/sketch';
import nonGuideTracking from './non-guide-tracking/sketch';
import groupCircleTargetTracking from './group-circle-target-tracking/sketch';
import reaching from './reaching/sketch';
import sharedSingleCursorControl from './shared-single-cursor-control/sketch';
import cursorControl20260706 from './cursor-control-20260706/sketch';
import task8 from './task8/sketch';
import task9 from './task9/sketch';

/**
 * Every experiment-task script keyed by its `ExperimentTaskType` id.
 * Mirrors `packages/server/src/experiments/index.ts`'s `taskRegistry`.
 *
 * Use `getSketchByExperimentTask(...)` when the caller knows which
 * experiment task is active (e.g. the admin client reads
 * `/agent/config`). Use `getSketchByTaskMode(...)` for the common
 * case where only the client-side TaskMode is in scope.
 */
export const EXPERIMENT_TASK_SKETCHES: Record<ExperimentTaskType, TaskSketch> = {
  'circle-target-tracking': circleTargetTracking,
  'guide-tracking': guideTracking,
  'non-guide-tracking': nonGuideTracking,
  'group-circle-target-tracking': groupCircleTargetTracking,
  'reaching': reaching,
  'shared-single-cursor-control': sharedSingleCursorControl,
  'cursor-control-20260706': cursorControl20260706,
  'task8': task8,
  'task9': task9,
};

export const allTaskSketches: TaskSketch[] = Object.values(EXPERIMENT_TASK_SKETCHES);

/**
 * Canonical sketch per `TaskMode`. When several experiment tasks register
 * for the same client-side mode (e.g. circle-target-tracking and group-
 * circle-target-tracking both use the `circle-target-tracking` mode), the
 * first one declared here wins. The other tasks' scripts remain
 * independently loadable via `getSketchByExperimentTask`.
 */
const TASK_MODE_TO_SKETCH: Partial<Record<TaskMode, TaskSketch>> = {
  'circle-target-tracking': circleTargetTracking,
  'guide-tracking': guideTracking,
  'manual-instruction': nonGuideTracking,
  'reaching': reaching,
  'shared-single-cursor': sharedSingleCursorControl,
};

export function getSketchByExperimentTask(type: ExperimentTaskType | null | undefined): TaskSketch | null {
  if (!type) return null;
  return EXPERIMENT_TASK_SKETCHES[type] ?? null;
}

export function getSketchByTaskMode(mode: TaskMode | null | undefined): TaskSketch | null {
  if (!mode) return null;
  return TASK_MODE_TO_SKETCH[mode] ?? null;
}
