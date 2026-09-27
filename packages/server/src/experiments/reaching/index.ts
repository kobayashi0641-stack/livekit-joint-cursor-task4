/**
 * Reaching task — visuomotor rotation paradigm.
 *
 * Trials are split into three phases:
 *   • Baseline (no rotation)            — `reachingPreTrials` trials
 *   • Adaptation (rotation applied)     — `reachingRotationTrials` trials
 *   • Washout (rotation removed)        — `reachingPostTrials` trials
 *
 * The rotation angle (degrees) is `reachingRotationDeg` during adaptation
 * and 0 during baseline/washout.
 */

import type { AgentRule, ExperimentConfig } from '../../agent-rules.js';
import { buildExecuteTrialRule } from '../common-flow.js';
import type { ExperimentTask } from '../types.js';
import { generateInstructions } from './instructions.js';
import { runTrialBody } from './experiment.js';

function buildReachingTrial(
  config: ExperimentConfig,
  experimentName: string,
  trialNumber: number,
  totalTrials: number,
  rotationDeg: number,
): AgentRule {
  const base = buildExecuteTrialRule(config, experimentName, trialNumber, totalTrials);
  return { ...base, cursorRotationDeg: rotationDeg };
}

function generateTrialSequence(
  config: ExperimentConfig,
  experimentName: string,
): AgentRule[] {
  const pre = Math.max(0, Math.floor(config.reachingPreTrials));
  const rot = Math.max(0, Math.floor(config.reachingRotationTrials));
  const post = Math.max(0, Math.floor(config.reachingPostTrials));
  const total = pre + rot + post;
  const rotDeg = config.reachingRotationDeg;

  const rules: AgentRule[] = [];
  let n = 1;
  for (let i = 0; i < pre; i++, n++) {
    rules.push(buildReachingTrial(config, experimentName, n, total, 0));
  }
  for (let i = 0; i < rot; i++, n++) {
    rules.push(buildReachingTrial(config, experimentName, n, total, rotDeg));
  }
  for (let i = 0; i < post; i++, n++) {
    rules.push(buildReachingTrial(config, experimentName, n, total, 0));
  }
  return rules;
}

export const reachingTask: ExperimentTask = {
  type: 'reaching',
  label: 'Reaching (Visuomotor Rotation)',
  liveKitTaskMode: 'reaching',
  generateInstructions,
  runTrialBody,
  generateTrialSequence,
  getInitialCursorPosition: (config) => ({
    x: config.reachingStartX,
    y: config.reachingStartY,
  }),
};
