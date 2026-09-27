/**
 * Trial body for the Reaching task.
 *
 * Each trial:
 *   1. Apply the trial's visuomotor rotation (0° baseline, ≠0° during adaptation).
 *   2. Re-calibrate the displayed avg cursor so it appears at the configured
 *      start position right before the target appears (defensive — the
 *      framework already calibrated at step 2 of `executeTrial`, this absorbs
 *      any drift during the "Start" countdown).
 *   3. Show the target as YELLOW (waiting state). Participants must hold still
 *      until the target turns red.
 *   4. After a random 300–800ms delay, switch the target to RED — this is the
 *      "go" signal. While waiting, watch for early movement of the displayed
 *      avg cursor; if displacement exceeds 20px (≈0.037 stage units), broadcast
 *      a one-shot warning. The trial proceeds either way.
 *   5. Wait until the displayed avg cursor (rawAvg − offset) is within the
 *      configured threshold of the target, or until the trial time limit hits.
 *   6. Hide the target. The surrounding `executeTrial` flow handles recording
 *      stop/upload and resetting display mode.
 *
 * Participants' individual cursors are *not* teleported here — that's done by
 * `executeTrial` (see {@link TrialContext.applyAvgCursorOffset} and the
 * `getInitialCursorPosition` paradigm).
 */

import type { TrialContext } from '../types.js';

// 20 px on a 540 px stage ≈ 0.037 stage units. Stage size is fixed by CSS
// (`540×540 max`); for smaller windows the threshold is slightly more
// sensitive in screen-px terms, which is acceptable.
const STAGE_SIZE_PX = 540;
const MOTION_THRESHOLD_PX = 20;
const MOTION_THRESHOLD_STAGE = MOTION_THRESHOLD_PX / STAGE_SIZE_PX;

const GO_DELAY_MIN_MS = 300;
const GO_DELAY_MAX_MS = 800;

const TARGET_COLOR_WAIT = '#facc15'; // Tailwind yellow-400
const TARGET_COLOR_GO = '#ef4444';   // Tailwind red-500 (matches existing reaching default)

export async function runTrialBody(ctx: TrialContext): Promise<void> {
  const { config } = ctx;
  const rotationDeg = ctx.cursorRotationDeg ?? 0;
  const targetX = config.reachingTargetX;
  const targetY = config.reachingTargetY;
  const startX = config.reachingStartX;
  const startY = config.reachingStartY;
  const threshold = config.reachingThreshold;
  const timeoutMs = ctx.durationSeconds * 1000;

  // 1. Set rotation for this trial (always — clears previous rotation when 0).
  await ctx.setCursorRotation(rotationDeg);

  // 2. Re-calibrate the displayed avg cursor to (startX, startY) just before
  //    the target appears, regardless of any drift since step 2 of executeTrial.
  await ctx.applyAvgCursorOffset(startX, startY);

  // 3. Show YELLOW target — participants must hold still until it turns red.
  await ctx.publishStaticTarget(targetX, targetY, 'circle', TARGET_COLOR_WAIT);
  await ctx.setTargetVisibility(true);
  if (ctx.signal.aborted) return;

  // 4. Random delay 300–800ms. While waiting, watch for early movement of the
  //    displayed avg cursor. If detected, broadcast a one-shot warning. The
  //    trial proceeds either way (the warning is feedback, not a restart).
  const goDelay =
    GO_DELAY_MIN_MS + Math.floor(Math.random() * (GO_DELAY_MAX_MS - GO_DELAY_MIN_MS + 1));
  await ctx.broadcastTop('Wait for the target to turn red before reaching.', goDelay + 200);

  const motionWatcher = (async () => {
    const result = await ctx.waitForAvgCursorFar(
      startX,
      startY,
      MOTION_THRESHOLD_STAGE,
      goDelay,
    );
    if (result.moved && !ctx.signal.aborted) {
      await ctx.broadcastTop(
        "Don't move yet — wait until the target turns RED before reaching.",
        2500,
      );
    }
  })();

  await ctx.sleep(goDelay);
  await motionWatcher; // ensure warning has been emitted before we proceed
  if (ctx.signal.aborted) return;

  // 5. Switch target to RED — this is the GO signal.
  await ctx.publishStaticTarget(targetX, targetY, 'circle', TARGET_COLOR_GO);

  // 6. Hint + wait for the displayed avg to reach the target (or timeout).
  //    Hit detection now lives in the **sketch** (web/src/experiments/
  //    reaching/sketch.ts → hit.detect). The admin client polls the
  //    predicate at the sketch's configured interval and POSTs a
  //    'reach' sketchEvent when it fires. This unblocks future tasks
  //    that need non-Euclidean hit geometry (rectangular goals, polygon
  //    containment, custom time-conditional logic) without server changes.
  //    `threshold` and `(targetX, targetY)` are still propagated to the
  //    sketch via ExperimentConfig, which the sketch reads from
  //    `ctx.config` inside its detect function.
  await ctx.broadcastTop('Move the avg cursor to the red target!', timeoutMs);
  // Pass threshold to the sketch via the control message params. The
  // sketch's hit.detect reads ctx.params.threshold to evaluate the
  // Euclidean condition. Future tasks may pass any params their detect
  // function needs (e.g. rectangle width/height, polygon vertices).
  await ctx.startSketchHitDetector({ threshold });
  try {
    await ctx.waitForSketchEvent('reach', timeoutMs);
  } finally {
    await ctx.stopSketchHitDetector();
  }

  // 7. Hide the target.
  await ctx.setTargetVisibility(false);
}
