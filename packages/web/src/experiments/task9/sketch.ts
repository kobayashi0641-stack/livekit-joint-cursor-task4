import type { CoordMap, P5Dot, SketchScene, TaskSketch } from '../types';
import { drawTarget } from '../shared/draw';
import {
  createTask9TargetGrid,
  createTask9TrialState,
  getTask9Clock,
  getTask9RenderState,
  syncTask9AuthoritativeState,
  updateTask9TrialHit,
  type Task9TrialState,
} from './point-to-point';

type Task9Phase = 'baseline' | 'shared' | 'washout';

const TARGET_DIAMETER = 30;
const GRID_OUTLINE_DIAMETER = 30;
const GRID = createTask9TargetGrid();

let trialState: Task9TrialState | null = null;
let trialStartedAt = 0;
let initializedEventKey = '';

function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function phaseParam(value: unknown): Task9Phase {
  return value === 'shared' || value === 'washout' ? value : 'baseline';
}

function controlCursor(scene: SketchScene, phase: Task9Phase): P5Dot | null {
  if (phase === 'shared') return scene.averages[0] ?? null;
  return scene.cursors[0] ?? null;
}

function pixelDistance(point: { x: number; y: number }, cursor: P5Dot, coords: CoordMap): number {
  return Math.hypot(coords.sx(point.x) - coords.sx(cursor.x), coords.sy(point.y) - coords.sy(cursor.y));
}

function dispatchState(
  eventName: 'task9-score-state' | 'task9-score-acquired',
  detail: Record<string, unknown>,
) {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

function ensureTrialState(scene: SketchScene, now: number): {
  state: Task9TrialState;
  phase: Task9Phase;
  countdownMs: number;
  durationMs: number;
  dwellMs: number;
  trialNumber: number;
} | null {
  const target = scene.target;
  const params = target?.trajectoryParams;
  if (!target || params?.task9PointToPoint !== true) return null;

  const trialKey = stringParam(params.trialKey, 'task9');
  const phase = phaseParam(params.phase);
  const seed = numberParam(params.seed, 1);
  const cursor = controlCursor(scene, phase);
  const identityKey = phase === 'shared' ? 'shared' : (cursor?.id ?? 'participant');
  const receivedAt = numberParam(target.trajectoryReceivedAt, now);

  if (!trialState || trialState.trialKey !== trialKey || trialState.identityKey !== identityKey) {
    trialState = createTask9TrialState(trialKey, seed, identityKey, receivedAt);
    trialStartedAt = receivedAt;
    initializedEventKey = '';
  }

  if (phase === 'shared') {
    const sequence = numberParam(params.sequence, 0);
    const score = numberParam(params.score, 0);
    const targetIndex = numberParam(params.targetIndex, trialState.targetIndex);
    const targetPresentedAt = numberParam(params.targetPresentedAt, receivedAt);
    trialState = syncTask9AuthoritativeState(trialState, {
      sequence,
      score,
      targetIndex,
      targetPresentedAt,
    });
  }

  const initKey = `${trialState.trialKey}:${trialState.identityKey}:${trialState.sequence}`;
  if (initializedEventKey !== initKey) {
    initializedEventKey = initKey;
    const point = GRID[trialState.targetIndex];
    dispatchState('task9-score-state', {
      trialKey,
      trialNumber: numberParam(params.trialNumber, 0),
      phase,
      identityKey,
      sequence: trialState.sequence,
      score: trialState.score,
      targetIndex: trialState.targetIndex,
      targetPosition: point,
      targetPresentedAt: trialState.targetPresentedAt,
    });
  }

  return {
    state: trialState,
    phase,
    countdownMs: Math.max(0, numberParam(params.countdownMs, 3000)),
    durationMs: Math.max(0, numberParam(params.durationMs, 30000)),
    dwellMs: Math.max(0, numberParam(params.dwellMs, 50)),
    trialNumber: numberParam(params.trialNumber, 0),
  };
}

function drawGrid(
  p: Parameters<TaskSketch['drawTaskLayer']>[0],
  coords: CoordMap,
  activeIndex: number,
  activeFill: string,
) {
  p.push();
  p.strokeWeight(2);
  for (let index = 0; index < GRID.length; index += 1) {
    const point = GRID[index];
    const active = index === activeIndex;
    if (active) {
      p.stroke(activeFill);
      p.fill(activeFill);
    } else {
      p.stroke('#9ca3af');
      p.noFill();
    }
    p.circle(coords.sx(point.x), coords.sy(point.y), active ? TARGET_DIAMETER : GRID_OUTLINE_DIAMETER);
  }
  p.pop();
}

function drawHud(
  p: Parameters<TaskSketch['drawTaskLayer']>[0],
  coords: CoordMap,
  score: number,
  remainingSeconds: number,
) {
  p.push();
  p.noStroke();
  p.fill('#111827');
  p.textStyle(p.BOLD);
  p.textSize(22);
  p.textAlign(p.LEFT, p.TOP);
  p.text(`Score: ${score}`, 18, 16);
  p.textAlign(p.RIGHT, p.TOP);
  p.text(`Time: ${remainingSeconds}`, coords.W - 18, 16);
  p.pop();
}

const sketch: TaskSketch = {
  id: 'task9',
  label: 'Point-to-Point Task',
  appliesTo: ['shared-single-cursor'],

  style: {
    cursor: { diameter: 16, fill: '#2563eb', opacity: 1 },
    average: { diameter: 16, fill: '#2563eb' },
    target: { shape: 'circle', size: TARGET_DIAMETER, fill: 'rgba(0,0,0,0)' },
    yesNo: { size: 80 },
  },

  defaults: {
    trialCount: 20,
    trialDurationSeconds: 30,
    minParticipants: 2,
    trialDisplayMode: 'avgOnly',
    cursorControlBaselineTrials: 3,
    cursorControlAdaptationTrials: 0,
    cursorControlSharedTrials: 5,
    cursorControlWashoutTrials: 2,
    cursorControlGainTargetA1: 1,
    cursorControlGainTargetB1: 1,
    cursorControlGainTargetA2: 1,
    cursorControlGainTargetB2: 1,
    cursorControlGainStepPerTrial: 0.1,
    cursorControlRotationTargetDeg1: 0,
    cursorControlRotationTargetDeg2: 0,
    cursorControlRotationStepDegPerTrial: 5,
    cursorControlRampStartSeconds: 5,
    cursorControlRampDurationSeconds: 10,
  },

  drawTaskLayer(p, scene, coords) {
    // The explicit Task9 sketch stays selected during the pre-experiment
    // manual-instruction screen. Its target has no Task9 trajectory metadata,
    // so render that generic circular waiting target before applying the
    // point-to-point trial state machine.
    if (scene.target && scene.target.trajectoryParams?.task9PointToPoint !== true) {
      drawTarget(p, scene.target, coords);
      return;
    }

    const now = Date.now();
    const trial = ensureTrialState(scene, now);
    if (!trial || !trialState) return;

    const clock = getTask9Clock(now - trialStartedAt, trial.countdownMs, trial.durationMs);
    const cursor = controlCursor(scene, trial.phase);
    const activePoint = GRID[trialState.targetIndex];
    const inside = cursor
      ? pixelDistance(activePoint, cursor, coords) <= TARGET_DIAMETER / 2
      : false;
    const renderState = getTask9RenderState(clock.phase, inside);

    if (clock.phase === 'countdown') {
      scene.lines = [];
      scene.cursors = [];
      scene.averages = [];
      p.push();
      p.noStroke();
      p.fill('#111827');
      p.textAlign(p.CENTER, p.CENTER);
      p.textStyle(p.BOLD);
      p.textSize(72);
      p.text(String(clock.countdown), coords.W / 2, coords.H / 2);
      p.pop();
      return;
    }
    if (!renderState.showTask) {
      scene.lines = [];
      scene.cursors = [];
      scene.averages = [];
      return;
    }

    drawGrid(p, coords, trialState.targetIndex, renderState.targetFill);
    drawHud(p, coords, trialState.score, clock.remainingSeconds);

    if (!cursor) return;
    const result = updateTask9TrialHit(
      trialState,
      inside,
      now,
      trial.dwellMs,
      trial.phase === 'shared' ? 'shared' : 'solo',
    );
    trialState = result.state;
    if (!result.acquisition) return;

    const acquisition = result.acquisition;
    dispatchState('task9-score-acquired', {
      ...acquisition,
      trialNumber: trial.trialNumber,
      phase: trial.phase,
      targetPosition: GRID[acquisition.targetIndex],
      nextTargetPosition: GRID[acquisition.nextTargetIndex],
    });
  },

  onDeactivate() {
    trialState = null;
    trialStartedAt = 0;
    initializedEventKey = '';
  },
};

export default sketch;
