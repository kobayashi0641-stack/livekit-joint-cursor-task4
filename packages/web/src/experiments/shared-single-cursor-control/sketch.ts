import type { CoordMap, P5Dot, P5Target, SketchScene, TaskSketch, TrajectoryParams } from '../types';
import { drawTarget } from '../shared/draw';

type LocalGateState = {
  key: string;
  holdStartedAt: number | null;
  targetStartedAt: number | null;
  startedReported: boolean;
  completed: boolean;
  reported: boolean;
};

let localGate: LocalGateState | null = null;

function numberArray(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value)) return fallback;
  return [0, 1, 2].map((idx) => {
    const n = Number(value[idx]);
    return Number.isFinite(n) ? n : fallback[idx];
  }) as [number, number, number];
}

function trajectoryAxis(
  t: number,
  amplitudes: [number, number, number],
  omegas: [number, number, number],
  phases: [number, number, number],
) {
  return amplitudes.reduce((sum, amp, idx) => {
    const phase = phases[idx];
    return sum + amp * (Math.cos(omegas[idx] * t + phase) - Math.cos(phase));
  }, 0);
}

function trajectory(elapsedMs: number, params: TrajectoryParams) {
  const t = elapsedMs / 1000;
  const amplitudes = numberArray(params.amplitudes, [0.080, 0.055, 0.045]);
  const omegaX = numberArray(params.omegaX, [0.90, 1.55, 2.35]);
  const omegaY = numberArray(params.omegaY, [0.95, 1.65, 2.20]);
  const phaseX = numberArray(params.phaseX, [0, Math.PI / 2, Math.PI]);
  const phaseY = numberArray(params.phaseY, [Math.PI / 4, Math.PI, Math.PI / 2]);
  return {
    x: 0.5 + trajectoryAxis(t, amplitudes, omegaX, phaseX),
    y: 0.5 + trajectoryAxis(t, amplitudes, omegaY, phaseY),
    shape: 'circle' as const,
  };
}

function numericParam(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function targetKey(target: P5Target) {
  const key = target.trajectoryParams?.trialKey;
  return typeof key === 'string' ? key : `${target.trajectoryReceivedAt ?? 0}:${target.trajectoryElapsedMs ?? 0}`;
}

function controlCursor(scene: SketchScene): P5Dot | null {
  return scene.averages[0] ?? scene.cursors[0] ?? null;
}

function pixelDistance(a: { x: number; y: number }, b: { x: number; y: number }, coords: CoordMap) {
  const dx = coords.sx(a.x) - coords.sx(b.x);
  const dy = coords.sy(a.y) - coords.sy(b.y);
  return Math.hypot(dx, dy);
}

function updateLocalGate(sceneTarget: P5Target, scene: SketchScene, coords: CoordMap) {
  const params = sceneTarget.trajectoryParams;
  if (!params?.localStartGate) return Date.now();

  const key = targetKey(sceneTarget);
  if (!localGate || localGate.key !== key) {
    localGate = {
      key,
      holdStartedAt: null,
      targetStartedAt: null,
      startedReported: false,
      completed: false,
      reported: false,
    };
  }
  if (localGate.completed) return null;
  if (localGate.targetStartedAt !== null) return localGate.targetStartedAt;

  const cursor = controlCursor(scene);
  if (!cursor) return null;

  const home = { x: 0.5, y: 0.5 };
  const insideHome = pixelDistance(cursor, home, coords) < sceneTarget.size / 2;
  const now = Date.now();
  if (!insideHome) {
    localGate.holdStartedAt = null;
    return null;
  }

  if (localGate.holdStartedAt === null) {
    localGate.holdStartedAt = now;
  }
  const holdMs = Math.max(0, numericParam(params.holdMs, 750));
  if (now - localGate.holdStartedAt >= holdMs) {
    localGate.targetStartedAt = now;
    if (!localGate.startedReported) {
      localGate.startedReported = true;
      window.dispatchEvent(new CustomEvent('shared-tracking-start', {
        detail: {
          trialKey: key,
          trialNumber: numericParam(params.trialNumber, 0),
          questionnaireRequired: params.questionnaireRequired === true,
          showFirstTrialHitHint: params.showFirstTrialHitHint === true,
          durationMs: Math.max(0, numericParam(params.durationMs, 35000)),
        },
      }));
    }
    return localGate.targetStartedAt;
  }
  return null;
}

function smoothTarget(sceneTarget: P5Target, scene: SketchScene, coords: CoordMap) {
  const params = sceneTarget.trajectoryParams;
  const elapsedMs = sceneTarget.trajectoryElapsedMs;
  const receivedAt = sceneTarget.trajectoryReceivedAt;
  if (!params || typeof elapsedMs !== 'number' || typeof receivedAt !== 'number') {
    return sceneTarget;
  }
  const localStartAt = updateLocalGate(sceneTarget, scene, coords);
  if (params.localStartGate && localStartAt === null) {
    if (localGate?.completed && !localGate.reported) {
      localGate.reported = true;
      const trialKey = targetKey(sceneTarget);
      window.dispatchEvent(new CustomEvent('shared-tracking-complete', {
        detail: {
          trialKey,
          trialNumber: numericParam(params.trialNumber, 0),
          questionnaireRequired: params.questionnaireRequired === true,
        },
      }));
    }
    return {
      ...sceneTarget,
      x: 0.5,
      y: 0.5,
      shape: 'circle' as const,
    };
  }
  const effectiveElapsed = params.localStartGate
    ? Math.max(0, Date.now() - (localStartAt ?? Date.now()))
    : elapsedMs + Math.max(0, Date.now() - receivedAt);
  const durationMs = Math.max(0, numericParam(params.durationMs, 35000));
  if (params.localStartGate && effectiveElapsed >= durationMs) {
    if (localGate) {
      localGate.completed = true;
      if (!localGate.reported) {
        localGate.reported = true;
        const trialKey = targetKey(sceneTarget);
        window.dispatchEvent(new CustomEvent('shared-tracking-complete', {
          detail: {
            trialKey,
            trialNumber: numericParam(params.trialNumber, 0),
            questionnaireRequired: params.questionnaireRequired === true,
          },
        }));
      }
    }
    return null;
  }
  const output = trajectory(effectiveElapsed, params);
  return {
    ...sceneTarget,
    x: output.x,
    y: output.y,
    shape: output.shape ?? sceneTarget.shape,
  };
}

function isHit(
  target: { x: number; y: number; size: number },
  scene: Parameters<TaskSketch['drawTaskLayer']>[1],
  coords: Parameters<TaskSketch['drawTaskLayer']>[2],
) {
  const cursor = controlCursor(scene);
  if (!cursor) return false;
  return pixelDistance(cursor, target, coords) < target.size / 2;
}

const sketch: TaskSketch = {
  id: 'shared-single-cursor-control',
  label: 'Shared/Single Cursor Control',
  appliesTo: ['shared-single-cursor'],

  style: {
    cursor: { diameter: 16, fill: '#1d4ed8', opacity: 1 },
    average: { diameter: 16, fill: '#1d4ed8' },
    target: { shape: 'circle', size: 24, fill: '#dc2626' },
    yesNo: { size: 80 },
  },

  defaults: {
    trialCount: 30,
    trialDurationSeconds: 25,
    minParticipants: 2,
    trialDisplayMode: 'avgOnly',
    sharedPracticeTrials: 5,
    sharedMainTrials: 20,
    sharedSoloTrials: 5,
    sharedWait1MinSeconds: 0.8,
    sharedWait1MaxSeconds: 1.2,
    sharedWait2Seconds: 1.5,
    sharedMatrix: [0.5, 0.2, 0.5, -0.2, 0.2, 0.5, -0.2, 0.5],
    sharedTargetAmplitudes: [0.080, 0.055, 0.045],
    sharedTargetOmegaX: [0.90, 1.55, 2.35],
    sharedTargetOmegaY: [0.95, 1.65, 2.20],
    sharedTargetPhaseX: [0, Math.PI / 2, Math.PI],
    sharedTargetPhaseY: [Math.PI / 4, Math.PI, Math.PI / 2],
    sharedRandomizePhasesPerTrial: true,
    sharedPhaseSeed: Math.floor(Math.random() * 2147483647) + 1,
  },

  trajectory: {
    compute: trajectory,
    intervalMs: 16,
  },

  drawTaskLayer(p, scene, coords) {
    if (!scene.target) return;
    const target = smoothTarget(scene.target, scene, coords);
    if (!target) return;
    drawTarget(p, {
      ...target,
      fill: isHit(target, scene, coords) ? '#16a34a' : target.fill,
    }, coords);
    if (
      scene.target.trajectoryParams?.localStartGate
      && localGate?.key === targetKey(scene.target)
      && localGate.targetStartedAt === null
      && !localGate.completed
    ) {
      const cx = coords.sx(target.x);
      const cy = coords.sy(target.y);
      p.push();
      p.noStroke();
      p.fill('#334155');
      p.textAlign(p.CENTER, p.CENTER);
      p.textStyle(p.BOLD);
      p.textSize(15);
      p.text('Home position', cx, cy - target.size / 2 - 34);
      p.textStyle(p.NORMAL);
      p.textSize(22);
      p.text('\u2193', cx, cy - target.size / 2 - 15);
      p.pop();
    }
  },

  onDeactivate() {
    localGate = null;
  },
};

export default sketch;
