import assert from 'node:assert/strict';
import test from 'node:test';

import * as task1Experiment from './experiments/cursor-control-20260706/experiment.js';
import * as task9Experiment from './experiments/task9/experiment.js';
import * as responsePolicy from './shared-contribution-policy.js';

test('Task1 requests the contribution question after Shared trials only', () => {
  const shouldAsk = (
    task1Experiment as unknown as {
      shouldAskSharedContribution?: (phase: string) => boolean;
    }
  ).shouldAskSharedContribution;

  assert.equal(typeof shouldAsk, 'function');
  if (!shouldAsk) return;
  assert.equal(shouldAsk('shared'), true);
  assert.equal(shouldAsk('baseline'), false);
  assert.equal(shouldAsk('washout'), false);
});

test('Task1 restores virtual cursor mode after each Shared questionnaire', async () => {
  const virtualCursorStates: boolean[] = [];
  await task1Experiment.runTrialBody({
    config: {
      sharedMatrix: [0.5, 0.2, 0.5, -0.2, 0.2, 0.5, -0.2, 0.5],
      sharedWait1MinSeconds: 0,
      sharedWait1MaxSeconds: 0,
      sharedRandomizePhasesPerTrial: false,
      sharedPhaseSeed: 1,
      sharedTargetPhaseX: [0, 0, 0],
      sharedTargetPhaseY: [0, 0, 0],
      sharedTargetAmplitudes: [0.08, 0.055, 0.045],
      sharedTargetOmegaX: [0.9, 1.55, 2.35],
      sharedTargetOmegaY: [0.95, 1.65, 2.2],
    },
    trialNumber: 1,
    totalTrials: 1,
    durationSeconds: 0,
    sharedPhase: 'shared',
    signal: new AbortController().signal,
    setSharedCursorControl: async () => {},
    setVirtualCursorPosition: async () => {},
    setTargetVisibility: async () => {},
    setRecordingMetadata: async () => {},
    publishInitialTargetWithTrajectory: async () => {},
    startSketchTrajectory: async () => {},
    waitForSharedTrackingCompletions: async () => ({ completed: 2 }),
    stopSketchTrajectory: async () => {},
    unlockPointerLock: async () => {},
    setUseVirtualCursor: async (enabled: boolean) => { virtualCursorStates.push(enabled); },
    setClickAreaOverlay: async () => {},
    showSharedCursorQuestionnaire: async () => {},
    waitForSharedCursorResponses: async () => ({ completed: 2 }),
    hideSharedCursorQuestionnaire: async () => {},
  } as never);

  assert.deepEqual(virtualCursorStates, [false, true]);
});

test('Task9 requests the contribution question after Shared trials only', () => {
  const shouldAsk = (
    task9Experiment as unknown as {
      shouldAskSharedContribution?: (phase: string) => boolean;
    }
  ).shouldAskSharedContribution;

  assert.equal(typeof shouldAsk, 'function');
  if (!shouldAsk) return;
  assert.equal(shouldAsk('shared'), true);
  assert.equal(shouldAsk('baseline'), false);
  assert.equal(shouldAsk('washout'), false);
});

test('Task9 collects one contribution response from each participant after a Shared trial', async () => {
  const calls: string[] = [];
  await task9Experiment.runTrialBody({
    config: {
      sharedMatrix: [0.5, 0.2, 0.5, -0.2, 0.2, 0.5, -0.2, 0.5],
      sharedPhaseSeed: 1,
    },
    trialNumber: 4,
    totalTrials: 10,
    durationSeconds: 0,
    sharedPhase: 'shared',
    signal: new AbortController().signal,
    setSharedCursorControl: async () => {},
    setVirtualCursorPosition: async () => {},
    setRecordingMetadata: async () => {},
    broadcastBottom: async () => {},
    publishInitialTargetWithTrajectory: async () => {},
    setTargetVisibility: async () => {},
    sleep: async () => {},
    unlockPointerLock: async () => { calls.push('unlock'); },
    setUseVirtualCursor: async (enabled: boolean) => { calls.push(`virtual:${enabled}`); },
    setClickAreaOverlay: async () => { calls.push('overlay:off'); },
    showSharedCursorQuestionnaire: async (trialNumber: number, kind: string) => {
      calls.push(`show:${trialNumber}:${kind}`);
    },
    waitForSharedCursorResponses: async (trialNumber: number, requiredCount: number) => {
      calls.push(`wait:${trialNumber}:${requiredCount}`);
      return { completed: requiredCount };
    },
    hideSharedCursorQuestionnaire: async () => { calls.push('hide'); },
  } as never);

  assert.deepEqual(calls, [
    'unlock',
    'virtual:false',
    'overlay:off',
    'show:4:contribution',
    'wait:4:2',
    'hide',
    'virtual:true',
  ]);
});

test('shared contribution response accepts integer values from 1 through 7 only', () => {
  const isValid = (
    responsePolicy as unknown as {
      isValidSharedContribution?: (value: unknown) => boolean;
    }
  ).isValidSharedContribution;

  assert.equal(typeof isValid, 'function');
  if (!isValid) return;
  assert.equal(isValid(1), true);
  assert.equal(isValid(4), true);
  assert.equal(isValid(7), true);
  assert.equal(isValid(0), false);
  assert.equal(isValid(8), false);
  assert.equal(isValid(9), false);
  assert.equal(isValid(4.5), false);
  assert.equal(isValid('4'), false);
});
