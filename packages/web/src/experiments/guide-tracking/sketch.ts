import { drawGuide, drawTarget } from '../shared/draw';
import type { TaskSketch } from '../types';

/**
 * Guide tracking — a static hollow circle (the "guide") is drawn so
 * participants can learn the orbit, then the guide vanishes mid-trial
 * and they continue from memory. The guide is enabled by
 * `setGuideTrackingRunning` on the control topic, which lands in
 * `scene.guide`.
 *
 * The pre-trial fragment of the task body sometimes also publishes a
 * concrete moving target before the guide takes over; that's why this
 * script also paints `scene.target` when present.
 */
const sketch: TaskSketch = {
  id: 'guide-tracking',
  label: 'Guide Tracking',
  appliesTo: ['guide-tracking'],

  // ── Visual parameters owned by this sketch ─────────────────────────────
  // Cursor / average diameters intentionally not set — admin sliders own
  // those. The sketch declares colors and guide stroke style.
  style: {
    average: { fill: '#1d4ed8' },
    target: { fill: '#ef4444' },
    guide: { stroke: '#8b0000', strokeWidth: 4 },
    lines: { width: 2 },
    yesNo: { size: 80 },
  },

  inputs: {
    cursorGain: 1.0,
  },

  defaults: {
    trialCount: 5,
    trialDurationSeconds: 20,
    circleTargetRadius: 0.3,
    trialDisplayMode: 'avgOnly',
  },

  drawTaskLayer(p, scene, coords) {
    if (scene.target) drawTarget(p, scene.target, coords);
    if (scene.guide) drawGuide(p, scene.guide, coords);
  },
};

export default sketch;
