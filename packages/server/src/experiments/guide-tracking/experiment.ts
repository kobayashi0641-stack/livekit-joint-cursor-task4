/**
 * Trial body for Guide Tracking.
 *
 * First half: an arc guide is rendered by the client (toggled via
 * `setGuideTrackingRunning`) for the first half of the trial, then hidden.
 *
 * Second half: participants continue the circular motion from memory.
 */

import type { TrialContext } from '../types.js';

export async function runTrialBody(ctx: TrialContext): Promise<void> {
  const { halfDurationMs, config } = ctx;

  // ── First half: guide visible ──────────────────────────────────────────
  // Pass the radius to clients so the guide is rendered at the
  // experiment-config size (researchers set this in AgentAdmin). Without
  // the radius arg, every client falls back to its own local default
  // (0.3) regardless of what the config says.
  await ctx.broadcastTop('Please trace the arc guide using the avg cursor.', halfDurationMs);
  await ctx.setGuideRunning(true, config.circleTargetRadius);
  await ctx.sleep(halfDurationMs);
  await ctx.setGuideRunning(false);
  if (ctx.signal.aborted) return;

  // ── Second half: guide hidden, participants continue from memory ───────
  await ctx.broadcastTop('Please move the avg cursor in a circular motion continuously.', halfDurationMs);
  await ctx.sleep(halfDurationMs);
}
