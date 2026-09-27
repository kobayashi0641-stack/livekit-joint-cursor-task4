/**
 * Trial body for Circle Target Tracking.
 *
 * First half: a square target orbits at the configured period/radius. The
 * **admin client's sketch** computes positions via its `trajectory.compute`
 * function and publishes on TARGET_TOPIC at the sketch's configured rate
 * (default 20Hz). The server agent only brackets the publish window via
 * `publishSketchTrajectory(params, durationMs)`.
 *
 * The motion equation lives in `web/src/experiments/circle-target-tracking/
 * sketch.ts` — researchers can change the trajectory shape (e.g. Lissajous,
 * eccentric, random walk) without touching this server file.
 *
 * Second half: the target is hidden and participants continue the circular
 * motion from memory.
 */

import type { TrialContext } from '../types.js';

export async function runTrialBody(ctx: TrialContext): Promise<void> {
  const { config, halfDurationMs } = ctx;
  const period = config.circleTargetPeriod;
  const radius = config.circleTargetRadius;

  // ── First half: target visible, admin sketch publishes positions ──────
  await ctx.broadcastTop('Please track the red target using the avg cursor.', halfDurationMs);
  await ctx.setTargetVisibility(true);
  // The sketch's trajectory.compute(elapsedMs, {period, radius}) returns
  // {x, y, shape:'square'} each frame. Admin publishes these on TARGET_TOPIC.
  await ctx.publishSketchTrajectory({ period, radius }, halfDurationMs);
  await ctx.setTargetVisibility(false);
  if (ctx.signal.aborted) return;

  // ── Second half: target hidden, participants continue from memory ──────
  await ctx.broadcastTop('Please move the avg cursor in a circular motion continuously.', halfDurationMs);
  await ctx.sleep(halfDurationMs);
}
