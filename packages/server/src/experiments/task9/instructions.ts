import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(config: ExperimentConfig): string[] {
  return [
    `Reach as many red targets as possible within ${config.trialDurationSeconds} seconds. Keep the cursor inside the target briefly to earn a point. Passing through does not count.`,
    'You will first complete baseline trials using your own cursor.',
    'After that, you will control a shared cursor with the other participant.',
    'After each shared-cursor trial, rate your contribution to earning the points.',
    'Finally, you will complete baseline trials again using your own cursor.',
  ];
}
