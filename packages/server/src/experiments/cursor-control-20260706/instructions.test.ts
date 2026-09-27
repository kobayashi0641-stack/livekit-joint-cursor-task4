import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_EXPERIMENT_CONFIG } from '../../agent-rules.js';
import { generateInstructions } from './instructions.js';

test('Task 1 inserts the shared-trial rating explanation before the final baseline page', () => {
  assert.deepEqual(generateInstructions(DEFAULT_EXPERIMENT_CONFIG), [
    'Move the cursor with your mouse or trackpad and track the target as accurately as possible.',
    'You will first complete baseline trials using your own cursor only.',
    'After that, you will control a shared cursor with the other participant.',
    'After each trial, rate how much you felt you contributed to controlling the shared cursor.',
    'Finally, you will complete baseline trials again using your own cursor only.',
  ]);
});
