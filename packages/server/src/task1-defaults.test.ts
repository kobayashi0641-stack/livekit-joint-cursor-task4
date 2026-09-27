import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_EXPERIMENT_CONFIG } from './agent-rules.js';

test('the default experiment profile is Task9 with 3 baseline, 5 shared, and 2 washout trials', () => {
  assert.deepEqual(
    {
      baseline: DEFAULT_EXPERIMENT_CONFIG.cursorControlBaselineTrials,
      shared: DEFAULT_EXPERIMENT_CONFIG.cursorControlSharedTrials,
      washout: DEFAULT_EXPERIMENT_CONFIG.cursorControlWashoutTrials,
    },
    { baseline: 3, shared: 5, washout: 2 },
  );
});
