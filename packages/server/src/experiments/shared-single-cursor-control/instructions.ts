import type { ExperimentConfig } from '../../agent-rules.js';

export function generateInstructions(_config: ExperimentConfig): string[] {
  return [
    'In this task, you will track a moving circular target as accurately as possible.',
    'You will first complete a few baseline trials using your own cursor only.',
    'After the baseline trials, you will control a shared cursor together with another participant.',
    'After each shared-cursor trial, please answer two short questions about how the movement felt.',
  ];
}
