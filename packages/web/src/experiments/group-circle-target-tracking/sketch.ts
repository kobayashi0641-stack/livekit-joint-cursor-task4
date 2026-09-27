import { drawTarget } from '../shared/draw';
import type { TaskSketch } from '../types';

/**
 * Group circle target tracking — same target visual as
 * `circle-target-tracking`, but participants are split into N groups
 * (Fisher–Yates shuffle, round-robin). Each group sees its own
 * intra-group average cursor (filtered client-side) and the
 * admin / viewer sees one colored avg per group.
 *
 * The grouping is handled at the data level: `scene.averages` already
 * contains the per-group averages (color-coded by `colorForGroup` in
 * App.tsx), so all this script renders is the same moving circle as
 * the non-group version.
 */
const sketch: TaskSketch = {
  id: 'group-circle-target-tracking',
  label: 'Group Circle Target Tracking',
  appliesTo: ['circle-target-tracking'],

  // ── Visual parameters owned by this sketch ─────────────────────────────
  // Cursor / average / target sizes intentionally not set — admin sliders
  // own those. Group-specific colors are handled by App.tsx's
  // GROUP_COLORS (or the optional colorPalette below).
  style: {
    target: { shape: 'square', fill: '#ef4444' },
    lines: { width: 2 },
    yesNo: { size: 80 },
  },

  inputs: {
    cursorGain: 1.0,
  },

  // trialCount here is *per phase* (split / re-shuffle / merge) — total is
  // trialCount × 3. See group-circle-target-tracking/index.ts on server.
  defaults: {
    trialCount: 5,
    trialDurationSeconds: 20,
    circleTargetPeriod: 5000,
    circleTargetRadius: 0.3,
    trialDisplayMode: 'avgOnly',
  },

  drawTaskLayer(p, scene, coords) {
    if (scene.target) drawTarget(p, scene.target, coords);
  },
};

export default sketch;
