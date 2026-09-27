/**
 * Task-specific instructions for the Non-guide Tracking (free circular motion) experiment.
 * No target or guide is shown; participants make circular motions freely.
 */

import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(config: ExperimentConfig): string[] {
  return [
    `In this experiment, please move the cursor in a circular motion on the screen for ${config.trialDurationSeconds} seconds.`,
    'There are no specific instructions regarding the direction, speed, or size of the movement.',
    'Please try to make the circular motion as smooth as possible.',
    `There are ${config.trialCount} trials in this experiment.`,
  ];
}
