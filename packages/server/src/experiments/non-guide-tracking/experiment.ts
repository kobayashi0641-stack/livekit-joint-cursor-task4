/**
 * Trial body for Non-guide Tracking (free circular motion).
 * No target or guide is shown — participants move in a circular motion freely
 * for the full trial duration.
 */

import type { TrialContext } from '../types.js';

export async function runTrialBody(ctx: TrialContext): Promise<void> {
  const { halfDurationMs } = ctx;
  const fullDurationMs = halfDurationMs * 2;

  // Persistent instruction at the bottom of the stage for the whole trial.
  await ctx.broadcastBottom(
    'Please try to make the circular motion as smooth as possible using the average cursor.',
    fullDurationMs,
  );

  // First half — same hint as second half (kept as two sends to match the
  // existing UI cadence of two top messages per trial).
  await ctx.broadcastTop('Please move the avg cursor in a circular motion.', halfDurationMs);
  await ctx.sleep(halfDurationMs);
  if (ctx.signal.aborted) return;

  await ctx.broadcastTop('Please move the avg cursor in a circular motion.', halfDurationMs);
  await ctx.sleep(halfDurationMs);
}
