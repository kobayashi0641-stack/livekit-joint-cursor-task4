/**
 * Task-specific instructions for the Circle Target Tracking experiment.
 * Shown after the common 11 instructions, before trials begin.
 * Each instruction is presented with a Yes/No confirmation by the agent.
 */

import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(config: ExperimentConfig): string[] {
  const halfTrialDur = Math.floor(config.trialDurationSeconds / 2);
  return [
    `In this experiment, a target that moves in a circular pattern is displayed on the screen for ${halfTrialDur} seconds.`,
    'Please use the average cursor to track this target accurately.',
    `After ${halfTrialDur} seconds, the target will disappear, but please continue the circular motion for another ${halfTrialDur} seconds.`,
    "Please move the average cursor as closely as possible to the target's movement.",
    `There are ${config.trialCount} trials in this experiment.`,
  ];
}
