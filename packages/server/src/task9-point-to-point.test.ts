import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_EXPERIMENT_CONFIG } from './agent-rules.js';
import { runTrialBody } from './experiments/task9/experiment.js';
import { task9Task } from './experiments/task9/index.js';

test('Task9 is the server default with 3/5/2 trials lasting 30 seconds', () => {
  assert.deepEqual(
    {
      taskType: DEFAULT_EXPERIMENT_CONFIG.taskType,
      baseline: DEFAULT_EXPERIMENT_CONFIG.cursorControlBaselineTrials,
      shared: DEFAULT_EXPERIMENT_CONFIG.cursorControlSharedTrials,
      washout: DEFAULT_EXPERIMENT_CONFIG.cursorControlWashoutTrials,
      seconds: DEFAULT_EXPERIMENT_CONFIG.trialDurationSeconds,
    },
    { taskType: 'task9', baseline: 3, shared: 5, washout: 2, seconds: 30 },
  );
});

test('Task9 uses a 30-second baseline/shared/washout point-to-point sequence', () => {
  assert.equal(task9Task.label, 'Point-to-Point Task');
  assert.deepEqual(task9Task.getInitialCursorPosition?.(DEFAULT_EXPERIMENT_CONFIG), { x: 0.5, y: 0.5 });

  const rules = task9Task.generateTrialSequence?.({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'task9',
    cursorControlBaselineTrials: 2,
    cursorControlAdaptationTrials: 4,
    cursorControlSharedTrials: 3,
    cursorControlWashoutTrials: 2,
    trialDurationSeconds: 30,
  }, 'task9-test') ?? [];
  const trials = rules.filter((rule) => rule.type === 'executeTrial');

  assert.equal(trials.length, 7);
  assert.deepEqual(trials.map((rule) => rule.sharedPhase), [
    'baseline', 'baseline',
    'shared', 'shared', 'shared',
    'washout', 'washout',
  ]);
  assert.deepEqual(trials.map((rule) => rule.displayMode), [
    'self', 'self',
    'avgOnly', 'avgOnly', 'avgOnly',
    'self', 'self',
  ]);
  assert.ok(trials.every((rule) => rule.durationSeconds === 30));
});

test('Task9 instructions include the shared-trial contribution rating page', () => {
  assert.deepEqual(task9Task.generateInstructions(DEFAULT_EXPERIMENT_CONFIG), [
    'Reach as many red targets as possible within 30 seconds. Keep the cursor inside the target briefly to earn a point. Passing through does not count.',
    'You will first complete baseline trials using your own cursor.',
    'After that, you will control a shared cursor with the other participant.',
    'After each shared-cursor trial, rate your contribution to earning the points.',
    'Finally, you will complete baseline trials again using your own cursor.',
  ]);
});

test('Task9 instruction uses the configured trial duration', () => {
  const instructions = task9Task.generateInstructions({
    ...DEFAULT_EXPERIMENT_CONFIG,
    trialDurationSeconds: 45,
  });

  assert.equal(
    instructions[0],
    'Reach as many red targets as possible within 45 seconds. Keep the cursor inside the target briefly to earn a point. Passing through does not count.',
  );
});

test('Task9 clears the inter-trial upload notice immediately before countdown setup', async () => {
  const calls: string[] = [];
  const metadata: Array<Record<string, unknown>> = [];
  const targetParams: Array<Record<string, unknown>> = [];
  const noop = async () => undefined;
  await runTrialBody({
    config: { ...DEFAULT_EXPERIMENT_CONFIG, taskType: 'task9' },
    trialNumber: 2,
    durationSeconds: 30,
    sharedPhase: 'baseline',
    signal: new AbortController().signal,
    broadcastBottom: async (text: string, durationMs: number) => {
      calls.push(`broadcast:${JSON.stringify(text)}:${durationMs}`);
    },
    setSharedCursorControl: noop,
    setVirtualCursorPosition: async (x: number, y: number) => { calls.push(`reset:${x}:${y}`); },
    setTargetVisibility: noop,
    setRecordingMetadata: async (value: Record<string, unknown>) => { metadata.push(value); },
    publishInitialTargetWithTrajectory: async (value: Record<string, unknown>) => {
      targetParams.push(value);
      calls.push('countdown-setup');
    },
    sleep: async (durationMs: number) => { calls.push(`sleep:${durationMs}`); },
  } as never);

  const countdownSetup = calls.indexOf('countdown-setup');
  assert.deepEqual(calls.slice(countdownSetup - 1, countdownSetup + 1), ['broadcast:"":1', 'countdown-setup']);
  assert.deepEqual(calls.slice(countdownSetup + 1), [
    'sleep:3000',
    'reset:0.5:0.5',
    'sleep:30000',
  ]);
  assert.equal(metadata[0]?.targetCount, 19);
  assert.equal(targetParams[0]?.targetCount, 19);
});
