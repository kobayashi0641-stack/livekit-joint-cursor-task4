import type { TrialContext } from '../types.js';

const COUNTDOWN_MS = 3000;
const DWELL_MS = 50;

export function shouldAskSharedContribution(phase: string): boolean {
  return phase === 'shared';
}

export async function runTrialBody(ctx: TrialContext): Promise<void> {
  const { config } = ctx;
  const requiredParticipants = 2;
  const phase = ctx.sharedPhase ?? 'shared';
  const needsQuestionnaire = shouldAskSharedContribution(phase);
  await ctx.setSharedCursorControl({
    enabled: true,
    phase,
    matrix: config.sharedMatrix,
    visualGain: ctx.sharedVisualGain,
    disturbance: ctx.sharedDisturbance,
  });
  await ctx.setVirtualCursorPosition(0.5, 0.5);
  if (ctx.signal.aborted) return;

  const durationMs = ctx.durationSeconds * 1000;
  const trialKey = `${ctx.trialNumber}-${Date.now()}`;
  const gameParams = {
    task9PointToPoint: true,
    trialKey,
    trialNumber: ctx.trialNumber,
    phase,
    seed: (Math.floor(config.sharedPhaseSeed) ^ Math.imul(ctx.trialNumber, 0x9E3779B1)) >>> 0,
    countdownMs: COUNTDOWN_MS,
    dwellMs: DWELL_MS,
    targetCount: 19,
    shape: 'circle',
    durationMs,
  };
  await ctx.setRecordingMetadata({
    phase,
    trialKey,
    task: 'point-to-point',
    countdownMs: COUNTDOWN_MS,
    dwellMs: DWELL_MS,
    durationMs,
    targetCount: 19,
    cursorControl: {
      phase,
      matrix: config.sharedMatrix,
      visualGain: ctx.sharedVisualGain ?? 1,
      disturbance: ctx.sharedDisturbance ?? null,
    },
    pointToPoint: gameParams,
  });
  // Replace the long-lived inter-trial upload notice immediately before the
  // new trial's countdown state is published.
  await ctx.broadcastBottom('', 1);
  await ctx.publishInitialTargetWithTrajectory(gameParams);
  await ctx.setTargetVisibility(true);
  try {
    await ctx.sleep(COUNTDOWN_MS);
    if (ctx.signal.aborted) return;
    // Participants may move the hidden cursor during the countdown. Re-center
    // at the reveal boundary so every trial visibly starts from the origin.
    await ctx.setVirtualCursorPosition(0.5, 0.5);
    await ctx.sleep(durationMs);
  } finally {
    await ctx.setTargetVisibility(false);
    await ctx.setSharedCursorControl({ enabled: false });
  }
  if (ctx.signal.aborted || !needsQuestionnaire) return;

  await ctx.unlockPointerLock();
  await ctx.setUseVirtualCursor(false);
  await ctx.setClickAreaOverlay(false);
  await ctx.showSharedCursorQuestionnaire(ctx.trialNumber, 'contribution');
  await ctx.waitForSharedCursorResponses(ctx.trialNumber, requiredParticipants, 120000);
  await ctx.hideSharedCursorQuestionnaire();
  await ctx.setUseVirtualCursor(true);
}
