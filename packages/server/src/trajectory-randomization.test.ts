import assert from 'node:assert/strict';
import test from 'node:test';

import { ExperimentAgent } from './agent.js';
import { DEFAULT_EXPERIMENT_CONFIG } from './agent-rules.js';
import { runTrialBody } from './experiments/cursor-control-20260706/experiment.js';

function createAgent(): ExperimentAgent {
  return new ExperimentAgent({
    listParticipants: async () => [],
    sendData: async () => undefined,
  } as never, 'joint-cursor-task2');
}

test('starting Task1 assigns a fresh trajectory phase seed to the experiment pair', async () => {
  const agent = createAgent();
  agent.setConfig({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'cursor-control-20260706',
    sharedRandomizePhasesPerTrial: true,
    sharedPhaseSeed: 123,
  });

  const originalRandom = Math.random;
  Math.random = () => 0.5;
  let running: Promise<void> | undefined;
  try {
    running = agent.start();
    assert.equal(agent.getConfig().sharedPhaseSeed, 1_073_741_824);
  } finally {
    agent.stop();
    await running;
    Math.random = originalRandom;
  }
});

test('recovery assigns a fresh trajectory phase seed before waiting for the next pair', () => {
  const agent = createAgent();
  agent.setConfig({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'cursor-control-20260706',
    sharedRandomizePhasesPerTrial: true,
    sharedPhaseSeed: 123,
  });

  const originalRandom = Math.random;
  Math.random = () => 0.25;
  try {
    const internals = agent as unknown as {
      prepareForRecoveredSessionRestart: () => void;
    };
    internals.prepareForRecoveredSessionRestart();
    assert.equal(agent.getConfig().sharedPhaseSeed, 536_870_912);
  } finally {
    Math.random = originalRandom;
  }
});

test('disabling phase randomization preserves the configured fixed phases and seed', async () => {
  const agent = createAgent();
  agent.setConfig({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'cursor-control-20260706',
    sharedRandomizePhasesPerTrial: false,
    sharedPhaseSeed: 123,
  });

  const running = agent.start();
  assert.equal(agent.getConfig().sharedPhaseSeed, 123);
  agent.stop();
  await running;
});

async function captureTrajectoryForTrial(trialNumber: number): Promise<Record<string, unknown>> {
  let trajectory: Record<string, unknown> | undefined;
  const noop = async () => undefined;
  await runTrialBody({
    config: {
      ...DEFAULT_EXPERIMENT_CONFIG,
      taskType: 'cursor-control-20260706',
      sharedRandomizePhasesPerTrial: true,
      sharedPhaseSeed: 987_654_321,
    },
    trialNumber,
    durationSeconds: 20,
    sharedPhase: 'baseline',
    signal: new AbortController().signal,
    broadcastBottom: noop,
    setSharedCursorControl: noop,
    setVirtualCursorPosition: noop,
    setTargetVisibility: noop,
    setRecordingMetadata: async (metadata: Record<string, unknown>) => {
      trajectory = metadata.trajectory as Record<string, unknown>;
    },
    publishInitialTargetWithTrajectory: noop,
    startSketchTrajectory: noop,
    waitForSharedTrackingCompletions: noop,
    stopSketchTrajectory: noop,
  } as never);
  assert.ok(trajectory);
  return trajectory;
}

test('each trial derives a different reproducible set of six target phases', async () => {
  const trial1 = await captureTrajectoryForTrial(1);
  const trial1Repeat = await captureTrajectoryForTrial(1);
  const trial2 = await captureTrajectoryForTrial(2);

  assert.deepEqual(trial1.phaseX, trial1Repeat.phaseX);
  assert.deepEqual(trial1.phaseY, trial1Repeat.phaseY);
  assert.notDeepEqual(
    { phaseX: trial1.phaseX, phaseY: trial1.phaseY },
    { phaseX: trial2.phaseX, phaseY: trial2.phaseY },
  );
  assert.equal((trial1.phaseX as unknown[]).length, 3);
  assert.equal((trial1.phaseY as unknown[]).length, 3);
});
