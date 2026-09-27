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
  type Task9Acquisition,
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

test('Task9 keeps all grid outlines and renders two active red targets', () => {
  const seed = 321;
  const grid = createTask9TargetGrid();
  const selectNextTargetPair = (task9PointToPoint as unknown as {
    selectNextTargetPair: (seed: number, sequence: number, previousIndex: number) => [number, number];
  }).selectNextTargetPair;
  const pair = selectNextTargetPair(seed, 0, 0);
  const fills: Array<string | null> = [];
  let currentFill: string | null = null;
  const p = {
    BOLD: 'bold', LEFT: 'left', RIGHT: 'right', TOP: 'top',
    push() {}, pop() {}, strokeWeight() {}, stroke() {}, noStroke() {},
    fill(value: string) { currentFill = value; },
    noFill() { currentFill = null; },
    circle() { fills.push(currentFill); },
    textStyle() {}, textSize() {}, textAlign() {}, text() {},
  };
  const now = Date.now();
  const scene = {
    viewport: { minX: 0, minY: 0, rangeX: 1, rangeY: 1 },
    taskMode: 'shared-single-cursor',
    cursors: [],
    averages: [],
    lines: [],
    target: {
      x: 0.5,
      y: 0.5,
      shape: 'circle',
      size: 30,
      fill: '#dc2626',
      trajectoryReceivedAt: now - 4000,
      trajectoryParams: {
        task9PointToPoint: true,
        trialKey: 'two-target-render',
        trialNumber: 1,
        phase: 'baseline',
        seed,
        countdownMs: 3000,
        durationMs: 30000,
        dwellMs: 50,
      },
    },
    guide: null,
    yesNo: null,
  };
  const coords = { sx: (x: number) => x * 540, sy: (y: number) => y * 540, W: 540, H: 540 };

  const originalWindow = globalThis.window;
  const originalCustomEvent = globalThis.CustomEvent;
  Object.assign(globalThis, {
    window: { dispatchEvent() {} },
    CustomEvent: class {
      constructor(public type: string, public init: { detail: unknown }) {}
    },
  });
  try {
    task9Sketch.onDeactivate?.();
    task9Sketch.drawTaskLayer(p as never, scene as never, coords);
  } finally {
    Object.assign(globalThis, { window: originalWindow, CustomEvent: originalCustomEvent });
  }

  assert.equal(fills.length, 19);
  assert.equal(fills.filter((fill) => fill === '#16a34a').length, 0);
  assert.equal(fills.filter((fill) => fill === '#dc2626').length, 2);
  assert.equal(fills.filter((fill) => fill === null).length, 17);

  fills.length = 0;
  currentFill = null;
  const hoverScene = {
    ...scene,
    cursors: [{ id: 'participant-a', x: grid[pair[0]].x, y: grid[pair[0]].y }],
    target: {
      ...scene.target,
      trajectoryParams: {
        ...scene.target.trajectoryParams,
        trialKey: 'two-target-render-hover',
      },
    },
  };
  Object.assign(globalThis, {
    window: { dispatchEvent() {} },
    CustomEvent: class {
      constructor(public type: string, public init: { detail: unknown }) {}
    },
  });
  try {
    task9Sketch.onDeactivate?.();
    task9Sketch.drawTaskLayer(p as never, hoverScene as never, coords);
  } finally {
    Object.assign(globalThis, { window: originalWindow, CustomEvent: originalCustomEvent });
  }
  assert.equal(fills.filter((fill) => fill === '#16a34a').length, 1);
  assert.equal(fills.filter((fill) => fill === '#dc2626').length, 1);
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

test('selects a deterministic pair of distinct targets equidistant from every anchor', () => {
  const selectNextTargetPair = (task9PointToPoint as unknown as {
    selectNextTargetPair?: (seed: number, sequence: number, previousIndex: number) => [number, number];
  }).selectNextTargetPair;
  assert.equal(typeof selectNextTargetPair, 'function');
  if (!selectNextTargetPair) return;

  const grid = createTask9TargetGrid();
  for (let anchorIndex = 0; anchorIndex < grid.length; anchorIndex += 1) {
    for (let seed = 1; seed <= 50; seed += 1) {
      const pair = selectNextTargetPair(seed, seed - 1, anchorIndex);
      assert.deepEqual(pair, selectNextTargetPair(seed, seed - 1, anchorIndex));
      assert.equal(pair.length, 2);
      assert.notEqual(pair[0], pair[1]);
      assert.notEqual(pair[0], anchorIndex);
      assert.notEqual(pair[1], anchorIndex);
      const firstDistance = Math.hypot(
        grid[pair[0]].x - grid[anchorIndex].x,
        grid[pair[0]].y - grid[anchorIndex].y,
      );
      const secondDistance = Math.hypot(
        grid[pair[1]].x - grid[anchorIndex].x,
        grid[pair[1]].y - grid[anchorIndex].y,
      );
      assert.ok(Math.abs(firstDistance - secondDistance) < 1e-9);
    }
  }
});

test('chooses among multiple distance shells rather than weighting all pairs together', () => {
  const selectNextTargetPair = (task9PointToPoint as unknown as {
    selectNextTargetPair?: (seed: number, sequence: number, previousIndex: number) => [number, number];
  }).selectNextTargetPair;
  assert.equal(typeof selectNextTargetPair, 'function');
  if (!selectNextTargetPair) return;

  const grid = createTask9TargetGrid();
  const anchorIndex = 0;
  const distances = new Set<number>();
  for (let seed = 1; seed <= 100; seed += 1) {
    const [targetIndex] = selectNextTargetPair(seed, 0, anchorIndex);
    distances.add(Number(Math.hypot(
      grid[targetIndex].x - grid[anchorIndex].x,
      grid[targetIndex].y - grid[anchorIndex].y,
    ).toFixed(9)));
  }
  assert.ok(distances.size > 1);
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

test('pair dwell resets when the cursor switches directly between offered targets', () => {
  const updateTargetDwellState = (task9PointToPoint as unknown as {
    updateTargetDwellState?: (
      state: { targetIndex: number | null; enteredAt: number | null; scored: boolean },
      insideTargetIndex: number | null,
      now: number,
      requiredMs: number,
    ) => { targetIndex: number | null; enteredAt: number | null; scored: boolean };
  }).updateTargetDwellState;
  assert.equal(typeof updateTargetDwellState, 'function');
  if (!updateTargetDwellState) return;

  let state = updateTargetDwellState({ targetIndex: null, enteredAt: null, scored: false }, 4, 1000, 50);
  assert.deepEqual(state, { targetIndex: 4, enteredAt: 1000, scored: false });
  state = updateTargetDwellState(state, 9, 1040, 50);
  assert.deepEqual(state, { targetIndex: 9, enteredAt: 1040, scored: false });
  state = updateTargetDwellState(state, 9, 1090, 50);
  assert.deepEqual(state, { targetIndex: 9, enteredAt: 1040, scored: true });
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
  const soloTarget = solo.targetIndices[0];
  const enteredSolo = updateTask9TrialHit(solo, soloTarget, 1100, 50, 'solo');
  solo = enteredSolo.state;
  const scoredSolo = updateTask9TrialHit(solo, soloTarget, 1150, 50, 'solo');
  assert.equal(scoredSolo.acquisition?.score, 1);
  assert.equal(scoredSolo.state.score, 1);
  assert.equal(scoredSolo.state.sequence, 1);
  assert.equal(scoredSolo.state.previousTargetIndex, soloTarget);
  assert.deepEqual(scoredSolo.state.targetIndices, scoredSolo.acquisition?.nextTargetIndices);
  const duplicateSolo = updateTask9TrialHit(scoredSolo.state, soloTarget, 1151, 50, 'solo');
  assert.equal(duplicateSolo.acquisition, null);

  let shared = createTask9TrialState('shared', 77, 'shared', 1000);
  const sharedTarget = shared.targetIndices[1];
  shared = updateTask9TrialHit(shared, sharedTarget, 1100, 50, 'shared').state;
  const proposedShared = updateTask9TrialHit(shared, sharedTarget, 1150, 50, 'shared');
  assert.equal(proposedShared.acquisition?.score, 1);
  assert.equal(proposedShared.state.score, 0);
  assert.equal(proposedShared.state.sequence, 0);
  assert.equal(updateTask9TrialHit(proposedShared.state, sharedTarget, 1160, 50, 'shared').acquisition, null);

  const synchronized = syncTask9AuthoritativeState(proposedShared.state, {
    sequence: 1,
    score: 1,
    previousTargetIndex: sharedTarget,
    targetIndices: proposedShared.acquisition!.nextTargetIndices,
    targetPresentedAt: 1150,
  });
  assert.equal(synchronized.score, 1);
  assert.equal(synchronized.sequence, 1);
  assert.deepEqual(synchronized.dwell, { targetIndex: null, enteredAt: null, scored: false });
});

test('a solo trial offers two center-anchored targets and branches from the acquired one', () => {
  const grid = createTask9TargetGrid();
  let state = createTask9TrialState('solo-pair', 77, 'participant-a', 1000) as unknown as {
    previousTargetIndex: number;
    targetIndices: [number, number];
    sequence: number;
    score: number;
  };
  assert.equal(state.previousTargetIndex, 0);
  assert.equal(state.targetIndices.length, 2);
  const initialDistances = state.targetIndices.map((index) => Math.hypot(
    grid[index].x - grid[0].x,
    grid[index].y - grid[0].y,
  ));
  assert.ok(Math.abs(initialDistances[0] - initialDistances[1]) < 1e-9);

  const acquiredIndex = state.targetIndices[1];
  state = updateTask9TrialHit(state as never, acquiredIndex as never, 1100, 50, 'solo').state as never;
  const scored = updateTask9TrialHit(state as never, acquiredIndex as never, 1150, 50, 'solo') as unknown as {
    state: typeof state;
    acquisition: {
      targetIndex: number;
      targetIndices: [number, number];
      unchosenTargetIndex: number;
      nextTargetIndices: [number, number];
    } | null;
  };
  assert.equal(scored.acquisition?.targetIndex, acquiredIndex);
  assert.deepEqual(scored.acquisition?.targetIndices, state.targetIndices);
  assert.equal(scored.acquisition?.unchosenTargetIndex, state.targetIndices[0]);
  assert.equal(scored.state.previousTargetIndex, acquiredIndex);
  assert.deepEqual(scored.state.targetIndices, scored.acquisition?.nextTargetIndices);
  const nextDistances = scored.state.targetIndices.map((index) => Math.hypot(
    grid[index].x - grid[acquiredIndex].x,
    grid[index].y - grid[acquiredIndex].y,
  ));
  assert.ok(Math.abs(nextDistances[0] - nextDistances[1]) < 1e-9);
});

test('shared authoritative advancement preserves the acquired branch and next pair', () => {
  let state = createTask9TrialState('shared-pair', 91, 'shared', 1000) as unknown as {
    previousTargetIndex: number;
    targetIndices: [number, number];
    sequence: number;
    score: number;
  };
  assert.ok(Array.isArray(state.targetIndices));
  if (!Array.isArray(state.targetIndices)) return;
  const acquiredIndex = state.targetIndices[0];
  state = updateTask9TrialHit(state as never, acquiredIndex as never, 1100, 50, 'shared').state as never;
  const proposed = updateTask9TrialHit(state as never, acquiredIndex as never, 1150, 50, 'shared') as unknown as {
    state: typeof state;
    acquisition: Task9Acquisition | null;
  };
  assert.ok(proposed.acquisition);
  assert.equal(proposed.state.sequence, 0);

  const params = {
    task9PointToPoint: true,
    trialKey: 'shared-pair',
    phase: 'shared',
    sequence: 0,
    score: 0,
    previousTargetIndex: 0,
    targetIndices: state.targetIndices,
  };
  const advanced = advanceTask9SharedTargetParams(params, proposed.acquisition!, 1150);
  assert.equal(advanced?.previousTargetIndex, acquiredIndex);
  assert.deepEqual(advanced?.targetIndices, proposed.acquisition?.nextTargetIndices);
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
    targetIndices: [4, 7] as [number, number],
    targetIndex: 4,
    unchosenTargetIndex: 7,
    nextTargetIndices: [9, 11] as [number, number],
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
    previousTargetIndex: 4,
    targetIndices: [9, 11],
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
