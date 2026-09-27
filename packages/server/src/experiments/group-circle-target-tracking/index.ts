/**
 * Group Circle Target Tracking — circle-target-tracking with random group splits.
 *
 * Phase 1 (trials 1..N): randomly split into 2 groups
 * Phase 2 (trials N+1..2N): re-shuffle into 2 new random groups
 * Phase 3 (trials 2N+1..3N): merge everyone into a single group
 *
 * `N = config.trialCount` (default 5 → 15 trials total).
 */

import type { AgentRule, ExperimentConfig } from '../../agent-rules.js';
import { buildExecuteTrialRule } from '../common-flow.js';
import type { ExperimentTask } from '../types.js';

import { generateInstructions } from './instructions.js';
import { runTrialBody } from './experiment.js';

function generateTrialSequence(config: ExperimentConfig, experimentName: string): AgentRule[] {
  const trialsPerPhase = Math.max(1, config.trialCount);
  const totalTrials = trialsPerPhase * 3;
  const rules: AgentRule[] = [];

  // Phase 1: initial random split into 2 groups
  rules.push({ type: 'computeGroups', groupCount: 2 });
  for (let i = 1; i <= trialsPerPhase; i++) {
    rules.push(buildExecuteTrialRule(config, experimentName, i, totalTrials));
  }

  // Phase 2: re-shuffle into 2 new random groups
  rules.push({ type: 'computeGroups', groupCount: 2 });
  for (let i = trialsPerPhase + 1; i <= trialsPerPhase * 2; i++) {
    rules.push(buildExecuteTrialRule(config, experimentName, i, totalTrials));
  }

  // Phase 3: merge into a single group of everyone
  rules.push({ type: 'computeGroups', groupCount: 1 });
  for (let i = trialsPerPhase * 2 + 1; i <= totalTrials; i++) {
    rules.push(buildExecuteTrialRule(config, experimentName, i, totalTrials));
  }

  return rules;
}

export const groupCircleTargetTrackingTask: ExperimentTask = {
  type: 'group-circle-target-tracking',
  label: 'Group Circle Target Tracking (split → reshuffle → merge)',
  liveKitTaskMode: 'circle-target-tracking',
  generateInstructions,
  runTrialBody,
  generateTrialSequence,
};
