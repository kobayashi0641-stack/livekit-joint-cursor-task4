import assert from 'node:assert/strict';
import test from 'node:test';

import task9Sketch from './sketch.js';
import * as task9PointToPoint from './point-to-point.js';
import {
  advanceTask9SharedTargetParams,
  createTask9TrialState,
  createTask9TargetGrid,
  getTask9Clock,
  getTask9RenderState,
  isTask9CompletionMessage,
  syncTask9AuthoritativeState,
  selectNextTargetIndex,
  shouldShowTask9SharedFeedback,
  updateTask9TrialHit,
  updateDwellState,
} from './point-to-point.js';

test('Task9 defaults to a 30-second point-to-point trial', () => {
  assert.equal(task9Sketch.label, 'Point-to-Point Task');
  assert.equal(task9Sketch.defaults?.trialDurationSeconds, 30);
});

test('Task9 target diameter is 30 pixels', () => {
  assert.equal(task9Sketch.style?.target?.size, 30);
});

test('shared cursor stays blue unless individual cursor feedback is enabled', () => {
  const getTask9SharedCursorFill = (task9PointToPoint as unknown as {
    getTask9SharedCursorFill?: (showIndividualFeedback: boolean) => string;
  }).getTask9SharedCursorFill;
  assert.equal(typeof getTask9SharedCursorFill, 'function');
  if (!getTask9SharedCursorFill) return;
  assert.equal(getTask9SharedCursorFill(false), '#2563eb');
  assert.equal(getTask9SharedCursorFill(true), '#111827');
  assert.equal(task9Sketch.style?.average?.fill, '#2563eb');
});

test('Task9 renders the generic moving red target while participants are waiting', () => {
  const ellipses: number[][] = [];
  const p = {
    push() {},
    pop() {},
    fill() {},
    noStroke() {},
    ellipse(...args: number[]) { ellipses.push(args); },
  };
  const scene = {
    viewport: { minX: 0, minY: 0, rangeX: 1, rangeY: 1 },
    taskMode: 'manual-instruction',
    cursors: [],
    averages: [],
    lines: [],
    target: {
      x: 0.63,
      y: 0.5,
      shape: 'circle',
      size: 44,
      fill: '#dc2626',
    },
    guide: null,
    yesNo: null,
  };
  const coords = { sx: (x: number) => x * 540, sy: (y: number) => y * 540, W: 540, H: 540 };

  task9Sketch.drawTaskLayer(p as never, scene as never, coords);

  assert.deepEqual(ellipses, [[340.2, 270, 44, 44]]);
});

test('creates 19 unique in-bounds triangular-lattice vertices with an outer two-spacing hexagon', () => {
  const grid = createTask9TargetGrid();
  assert.equal(grid.length, 19);
  assert.equal(new Set(grid.map((point) => `${point.x.toFixed(6)},${point.y.toFixed(6)}`)).size, 19);
  assert.deepEqual(grid[0], { x: 0.5, y: 0.5 });
  for (const point of grid) {
    assert.ok(point.x >= 0.1 && point.x <= 0.9);
    assert.ok(point.y >= 0.1 && point.y <= 0.9);
  }

  const center = grid[0];
  const nearestDistances = grid.slice(1, 7).map((point) => Math.hypot(point.x - center.x, point.y - center.y));
  assert.ok(nearestDistances.every((distance) => Math.abs(distance - nearestDistances[0]) < 1e-9));
  const outerHexagonDistances = grid.slice(13, 19).map((point) => Math.hypot(point.x - center.x, point.y - center.y));
  assert.ok(outerHexagonDistances.every((distance) => Math.abs(distance - nearestDistances[0] * 2) < 1e-9));
});

test('target selection is deterministic and never repeats immediately', () => {
  const firstA = selectNextTargetIndex(1234, 0, null, 'participant-a');
  const firstB = selectNextTargetIndex(1234, 0, null, 'participant-a');
  assert.equal(firstA, firstB);

  let previous = firstA;
  for (let sequence = 1; sequence < 100; sequence += 1) {
    const next = selectNextTargetIndex(1234, sequence, previous, 'participant-a');
    assert.notEqual(next, previous);
    previous = next;
  }
});

test('target selection uses a newly shuffled 19-target set without repeats at set boundaries', () => {
  const targetCount = createTask9TargetGrid().length;
  const sequence: number[] = [];
  let previous: number | null = null;
  for (let index = 0; index < targetCount * 4; index += 1) {
    previous = selectNextTargetIndex(0x12345678, index, previous, 'participant-a');
    sequence.push(previous);
  }

  const expectedTargets = Array.from({ length: targetCount }, (_, index) => index);
  const sets = Array.from({ length: 4 }, (_, setIndex) => (
    sequence.slice(setIndex * targetCount, (setIndex + 1) * targetCount)
  ));

  for (const set of sets) {
    assert.deepEqual([...set].sort((a, b) => a - b), expectedTargets);
  }
  for (let setIndex = 1; setIndex < sets.length; setIndex += 1) {
    assert.notDeepEqual(sets[setIndex], sets[setIndex - 1]);
    assert.notEqual(sets[setIndex][0], sets[setIndex - 1][targetCount - 1]);
  }
});

test('dwell requires 50 continuous milliseconds and resets after leaving', () => {
  let state = updateDwellState({ enteredAt: null, scored: false }, true, 1000, 50);
  assert.deepEqual(state, { enteredAt: 1000, scored: false });
  state = updateDwellState(state, true, 1049, 50);
  assert.equal(state.scored, false);
  state = updateDwellState(state, false, 1050, 50);
  assert.deepEqual(state, { enteredAt: null, scored: false });
  state = updateDwellState(state, true, 1100, 50);
  state = updateDwellState(state, true, 1150, 50);
  assert.deepEqual(state, { enteredAt: 1100, scored: true });
});

test('clock shows 3, 2, 1 and then a clamped 30-second trial timer', () => {
  assert.deepEqual(getTask9Clock(0, 3000, 30000), { phase: 'countdown', countdown: 3, remainingSeconds: 30 });
  assert.equal(getTask9Clock(1000, 3000, 30000).countdown, 2);
  assert.equal(getTask9Clock(2000, 3000, 30000).countdown, 1);
  assert.deepEqual(getTask9Clock(3000, 3000, 30000), { phase: 'running', countdown: null, remainingSeconds: 30 });
  assert.equal(getTask9Clock(4001, 3000, 30000).remainingSeconds, 29);
  assert.deepEqual(getTask9Clock(33001, 3000, 30000), { phase: 'complete', countdown: null, remainingSeconds: 0 });
});

test('both participants receive the same sequence within a pair', () => {
  const a = createTask9TrialState('trial-1', 99, 'participant-a', 1000);
  const b = createTask9TrialState('trial-1', 99, 'participant-b', 1000);
  assert.equal(a.targetIndex, b.targetIndex);

  let previousA = a.targetIndex;
  let previousB = b.targetIndex;
  for (let sequence = 1; sequence < 20; sequence += 1) {
    previousA = selectNextTargetIndex(99, sequence, previousA, 'participant-a');
    previousB = selectNextTargetIndex(99, sequence, previousB, 'participant-b');
    assert.equal(previousA, previousB);
  }
});

test('target sequence is re-randomized for each trial and experiment pair seed', () => {
  const sequenceFor = (seed: number) => {
    const result: number[] = [];
    let previous: number | null = null;
    for (let sequence = 0; sequence < 20; sequence += 1) {
      previous = selectNextTargetIndex(seed, sequence, previous, 'participant');
      result.push(previous);
    }
    return result;
  };
  assert.notDeepEqual(sequenceFor(1001), sequenceFor(1002));
  assert.notDeepEqual(sequenceFor(1001), sequenceFor(2001));
});

test('countdown hides cursors and targets, then running target reflects cursor overlap', () => {
  assert.deepEqual(getTask9RenderState('countdown', false), {
    showTask: false,
    showCursors: false,
    targetFill: '#dc2626',
  });
  assert.deepEqual(getTask9RenderState('running', false), {
    showTask: true,
    showCursors: true,
    targetFill: '#dc2626',
  });
  assert.equal(getTask9RenderState('running', true).targetFill, '#16a34a');
  assert.equal(getTask9RenderState('running', false).targetFill, '#dc2626');
});

test('solo acquisition advances once while shared acquisition waits for authoritative state', () => {
  let solo = createTask9TrialState('solo', 77, 'participant-a', 1000);
  const enteredSolo = updateTask9TrialHit(solo, true, 1100, 50, 'solo');
  solo = enteredSolo.state;
  const scoredSolo = updateTask9TrialHit(solo, true, 1150, 50, 'solo');
  assert.equal(scoredSolo.acquisition?.score, 1);
  assert.equal(scoredSolo.state.score, 1);
  assert.equal(scoredSolo.state.sequence, 1);
  assert.notEqual(scoredSolo.state.targetIndex, solo.targetIndex);
  const duplicateSolo = updateTask9TrialHit(scoredSolo.state, true, 1151, 50, 'solo');
  assert.equal(duplicateSolo.acquisition, null);

  let shared = createTask9TrialState('shared', 77, 'shared', 1000);
  shared = updateTask9TrialHit(shared, true, 1100, 50, 'shared').state;
  const proposedShared = updateTask9TrialHit(shared, true, 1150, 50, 'shared');
  assert.equal(proposedShared.acquisition?.score, 1);
  assert.equal(proposedShared.state.score, 0);
  assert.equal(proposedShared.state.sequence, 0);
  assert.equal(updateTask9TrialHit(proposedShared.state, true, 1160, 50, 'shared').acquisition, null);

  const synchronized = syncTask9AuthoritativeState(proposedShared.state, {
    sequence: 1,
    score: 1,
    targetIndex: proposedShared.acquisition!.nextTargetIndex,
    targetPresentedAt: 1150,
  });
  assert.equal(synchronized.score, 1);
  assert.equal(synchronized.sequence, 1);
  assert.deepEqual(synchronized.dwell, { enteredAt: null, scored: false });
});

test('admin advances shared score and target exactly once from a matching acquisition', () => {
  const params = {
    task9PointToPoint: true,
    trialKey: 'shared-trial',
    phase: 'shared',
    sequence: 0,
    score: 0,
  };
  const acquisition = {
    trialKey: 'shared-trial',
    identityKey: 'shared',
    sequence: 0,
    score: 1,
    targetIndex: 4,
    nextTargetIndex: 9,
    targetPresentedAt: 1000,
    acquiredAt: 1100,
    movementTimeMs: 100,
    dwellMs: 50,
  };

  const advanced = advanceTask9SharedTargetParams(params, acquisition, 1100);
  assert.deepEqual(advanced, {
    ...params,
    sequence: 1,
    score: 1,
    targetIndex: 9,
    targetPresentedAt: 1100,
  });
  assert.equal(advanceTask9SharedTargetParams(advanced!, acquisition, 1110), null);
});

test('shared feedback cursors are hidden by default and shown only in the admin-selected lines mode', () => {
  assert.equal(shouldShowTask9SharedFeedback(false, true, 'shared'), false);
  assert.equal(shouldShowTask9SharedFeedback(true, true, 'shared'), true);
  assert.equal(shouldShowTask9SharedFeedback(true, false, 'shared'), false);
  assert.equal(shouldShowTask9SharedFeedback(true, true, 'baseline'), false);
});

test('completion score follows only the inter-trial completion/upload message window', () => {
  assert.equal(isTask9CompletionMessage('Trial 3 of 10 is complete.\nData is now uploading...'), true);
  assert.equal(isTask9CompletionMessage('Trial 10 of 10 is complete.'), true);
  assert.equal(isTask9CompletionMessage(''), false);
  assert.equal(isTask9CompletionMessage('The next trial will start soon.'), false);
});

test('Shared score appears with the questionnaire but not on the later upload/wait screen', () => {
  const policy = task9PointToPoint as unknown as {
    shouldShowTask9QuestionnaireScore?: (
      phase: string | undefined,
      scoreTrialNumber: number,
      questionnaireTrialNumber: number,
      questionnaireVisible: boolean,
    ) => boolean;
    shouldShowTask9CompletionScore?: (
      phase: string | undefined,
      completionMessageVisible: boolean,
    ) => boolean;
  };

  assert.equal(typeof policy.shouldShowTask9QuestionnaireScore, 'function');
  assert.equal(typeof policy.shouldShowTask9CompletionScore, 'function');
  if (!policy.shouldShowTask9QuestionnaireScore || !policy.shouldShowTask9CompletionScore) return;

  assert.equal(policy.shouldShowTask9QuestionnaireScore('shared', 4, 4, true), true);
  assert.equal(policy.shouldShowTask9QuestionnaireScore('shared', 3, 4, true), false);
  assert.equal(policy.shouldShowTask9QuestionnaireScore('baseline', 4, 4, true), false);
  assert.equal(policy.shouldShowTask9CompletionScore('shared', true), false);
  assert.equal(policy.shouldShowTask9CompletionScore('baseline', true), true);
  assert.equal(policy.shouldShowTask9CompletionScore('washout', true), true);
  assert.equal(policy.shouldShowTask9CompletionScore('baseline', false), false);
});
