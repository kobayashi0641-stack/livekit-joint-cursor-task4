import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_EXPERIMENT_CONFIG } from '../../agent-rules.js';
import { generateInstructions } from './instructions.js';

test('places the two-target and point-transition explanations before baseline', () => {
  const instructions = generateInstructions(DEFAULT_EXPERIMENT_CONFIG);

  assert.equal(instructions.length, 6);
  assert.equal(
    instructions[0],
    'Two red targets will appear at the same time. Move the cursor to either one and stay on it briefly to earn a point.',
  );
  assert.equal(
    instructions[1],
    'Once you earn a point, the green target flashes and a new pair of targets appears. Reach as many red targets as possible within 30 seconds.',
  );
  assert.equal(
    instructions[2],
    'You will first complete baseline trials using your own cursor.',
  );
});
