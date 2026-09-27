/**
 * Task-specific instructions for the Group Circle Target Tracking experiment.
 *
 * Participants are randomly split into 2 groups for the first 2 phases, then
 * merged into one group for the final phase. Each phase has `trialCount`
 * trials (default 5), so the full experiment is `3 × trialCount` trials.
 */

import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(config: ExperimentConfig): string[] {
  const halfTrialDur = Math.floor(config.trialDurationSeconds / 2);
  const trialsPerPhase = config.trialCount;
  const totalTrials = trialsPerPhase * 3;

  return [
    `In this experiment, a target that moves in a circular pattern is displayed on the screen for ${halfTrialDur} seconds.`,
    'You will be randomly split into two groups. Each group has its own average cursor.',
    'Please use your group\'s average cursor to track this target accurately.',
    `After ${halfTrialDur} seconds, the target will disappear, but please continue the circular motion for another ${halfTrialDur} seconds.`,
    `The experiment has ${totalTrials} trials in total: ${trialsPerPhase} with the first random split, ${trialsPerPhase} after re-shuffling the groups, and ${trialsPerPhase} with everyone in a single group.`,
  ];
}
