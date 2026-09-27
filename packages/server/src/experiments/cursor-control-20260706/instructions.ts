import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(_config: ExperimentConfig): string[] {
  return [
    'Move the cursor with your mouse or trackpad and track the target as accurately as possible.',
    'You will first complete baseline trials using your own cursor only.',
    'After that, you will control a shared cursor with the other participant.',
    'After each trial, rate how much you felt you contributed to controlling the shared cursor.',
    'Finally, you will complete baseline trials again using your own cursor only.',
  ];
}
