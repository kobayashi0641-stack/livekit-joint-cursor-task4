/**
 * Task-specific instructions for the Guide Tracking experiment.
 * The arc guide is shown for the first half of each trial, then hidden.
 */

import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(config: ExperimentConfig): string[] {
  const halfTrialDur = Math.floor(config.trialDurationSeconds / 2);
  return [
    `In this experiment, an arc guide will be displayed on the screen for ${halfTrialDur} seconds.`,
    'Please use the average cursor to trace this guide precisely.',
    `After ${halfTrialDur} seconds, the guide will disappear, but please continue the circular motion for another ${halfTrialDur} seconds.`,
    'Please try to move the cursor in the same way you traced the guide.',
    `There are ${config.trialCount} trials in this experiment.`,
  ];
}
