import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(config: ExperimentConfig): string[] {
  return [
    'Two red targets will appear at the same time. Move the cursor to either one and stay on it briefly to earn a point.',
    `Once you earn a point, the green target flashes and a new pair of targets appears. Reach as many red targets as possible within ${config.trialDurationSeconds} seconds.`,
    'You will first complete baseline trials using your own cursor.',
    'After that, you will control a shared cursor with the other participant.',
    'After each shared-cursor trial, rate your contribution to earning the points.',
    'Finally, you will complete baseline trials again using your own cursor.',
  ];
}
