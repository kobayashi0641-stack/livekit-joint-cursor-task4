/**
 * Task-specific instructions for the Reaching experiment.
 * Shown after the common 11 instructions, before trials begin.
 * Each instruction is presented with a Yes/No confirmation by the agent.
 */

import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(config: ExperimentConfig): string[] {
  const total = config.reachingPreTrials + config.reachingRotationTrials + config.reachingPostTrials;
  return [
    'In this experiment, you will move the average cursor to a red circular target.',
    'A red circle target will appear at the upper part of the screen, and the average cursor will start near the bottom.',
    'When the target appears, please move your hand so that the average cursor reaches the target as quickly and accurately as possible.',
    'Each trial ends automatically when the average cursor reaches the target. The cursor then resets to the starting position for the next trial.',
    `There are ${total} trials in this experiment.`,
  ];
}
