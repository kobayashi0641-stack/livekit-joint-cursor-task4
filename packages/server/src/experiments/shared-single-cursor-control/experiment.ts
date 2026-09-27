import type { TrialContext } from '../types.js';

function randomWaitMs(minSeconds: number, maxSeconds: number): number {
  const min = Math.max(0, minSeconds);
  const max = Math.max(min, maxSeconds);
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPhaseTriples(seed: number, trialNumber: number): {
  phaseX: [number, number, number];
  phaseY: [number, number, number];
} {
  const mixedSeed = (Math.floor(seed) ^ Math.imul(trialNumber, 0x9E3779B1)) >>> 0;
  const rand = mulberry32(mixedSeed);
  const phase = (): number => {
    const u = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, rand()));
    return u * Math.PI * 2 - Math.PI;
  };
  return {
    phaseX: [phase(), phase(), phase()],
    phaseY: [phase(), phase(), phase()],
  };
}

export async function runTrialBody(ctx: TrialContext): Promise<void> {
  const { config } = ctx;
  const requiredParticipants = 2;
  const phase = ctx.sharedPhase ?? 'shared';
  const needsQuestionnaire = phase !== 'baseline';
  const homePositionInstruction = 'Keep the cursor in the home position.';
  const homePositionInstructionDurationMs =
    ctx.durationSeconds * 1000 + config.sharedWait1MaxSeconds * 1000 + 120000;

  await ctx.setSharedCursorControl({
    enabled: true,
    phase,
    matrix: config.sharedMatrix,
  });
  await ctx.broadcastBottom(homePositionInstruction, homePositionInstructionDurationMs);
  await ctx.setVirtualCursorPosition(0.5, 0.5);
  if (ctx.signal.aborted) return;

  await ctx.broadcastTop('Track the moving target as accurately as possible.', ctx.durationSeconds * 1000);
  await ctx.setTargetVisibility(true);
  const holdMs = randomWaitMs(config.sharedWait1MinSeconds, config.sharedWait1MaxSeconds);
  const durationMs = ctx.durationSeconds * 1000;
  const trialKey = `${ctx.trialNumber}-${Date.now()}`;
  const phases = config.sharedRandomizePhasesPerTrial
    ? randomPhaseTriples(config.sharedPhaseSeed, ctx.trialNumber)
    : { phaseX: config.sharedTargetPhaseX, phaseY: config.sharedTargetPhaseY };
  const trajectoryParams = {
    trialKey,
    trialNumber: ctx.trialNumber,
    questionnaireRequired: needsQuestionnaire,
    showFirstTrialHitHint: phase === 'baseline' && ctx.trialNumber === 1,
    amplitudes: config.sharedTargetAmplitudes,
    omegaX: config.sharedTargetOmegaX,
    omegaY: config.sharedTargetOmegaY,
    phaseX: phases.phaseX,
    phaseY: phases.phaseY,
    shape: 'circle',
    localStartGate: true,
    holdMs,
    durationMs,
  };
  await ctx.setRecordingMetadata({
    phase,
    trialKey,
    questionnaireRequired: needsQuestionnaire,
    homeHoldMs: holdMs,
    trackingDurationMs: durationMs,
    cursorControl: {
      phase,
      matrix: config.sharedMatrix,
    },
    trajectory: trajectoryParams,
  });
  await ctx.publishInitialTargetWithTrajectory(trajectoryParams);
  await ctx.startSketchTrajectory(trajectoryParams);
  try {
    await ctx.waitForSharedTrackingCompletions(
      trialKey,
      requiredParticipants,
      durationMs + holdMs + 120000,
    );
  } finally {
    await ctx.stopSketchTrajectory();
  }
  await ctx.setTargetVisibility(false);
  await ctx.setSharedCursorControl({ enabled: false });
  if (ctx.signal.aborted) return;

  if (needsQuestionnaire) {
    await ctx.unlockPointerLock();
    await ctx.setUseVirtualCursor(false);
    await ctx.setClickAreaOverlay(false);
    await ctx.showSharedCursorQuestionnaire(ctx.trialNumber);
    await ctx.waitForSharedCursorResponses(ctx.trialNumber, requiredParticipants, 120000);
    await ctx.hideSharedCursorQuestionnaire();
  }
}
