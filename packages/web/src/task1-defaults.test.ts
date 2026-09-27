import assert from 'node:assert/strict';
import test from 'node:test';

import task1Sketch from './experiments/cursor-control-20260706/sketch.js';

test('Task 1 sketch exposes the same 5/7/3 trial defaults used by the admin UI', () => {
  assert.deepEqual(
    {
      baseline: task1Sketch.defaults?.cursorControlBaselineTrials,
      shared: task1Sketch.defaults?.cursorControlSharedTrials,
      washout: task1Sketch.defaults?.cursorControlWashoutTrials,
    },
    { baseline: 5, shared: 7, washout: 3 },
  );
});
