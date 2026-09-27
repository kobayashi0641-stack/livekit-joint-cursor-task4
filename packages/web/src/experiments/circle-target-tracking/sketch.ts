import { drawTarget } from '../shared/draw';
import type { TaskSketch } from '../types';

/**
 * Circle target tracking — participants chase a single red square that
 * the agent moves along a circular orbit at 20Hz (published on the
 * `target` topic). The task name refers to the *motion*, not the shape:
 * the agent publishes shape='square' and the React `p5StageTarget`
 * memo maps the taskMode to the same shape so live/recording/replay
 * agree. The scene's `target` carries the live position + pixel size +
 * fill.
 *
 * No internal state: each frame just paints whatever the latest server
 * broadcast left in `scene.target`. The base sketch already renders
 * cursors / averages / Yes-No, so all this script owns is the moving
 * target itself.
 */
const sketch: TaskSketch = {
  id: 'circle-target-tracking',
  label: 'Circle Target Tracking',
  appliesTo: ['circle-target-tracking'],

  // ── Visual parameters owned by this sketch ─────────────────────────────
  // Diameter/size for cursor / average / target are *intentionally* not set
  // here so the admin panel's sliders (participantCursorSize,
  // averageCursorSize, circleTargetSize) remain the runtime authority.
  // The sketch declares colors and shape — properties that researchers
  // genuinely want to own per-task.
  style: {
    average: { fill: '#1d4ed8' },
    target: { shape: 'square', fill: '#ef4444' },
    lines: { width: 2 },
    yesNo: { size: 80 },
  },

  // ── Input transformation (pointer-lock only) ───────────────────────────
  // 1.0 = identity. Increase to amplify hand motion; the average cursor
  // ends up moving more for the same physical displacement.
  inputs: {
    cursorGain: 1.0,
  },

  // ── Experiment config defaults ─────────────────────────────────────────
  // AgentAdmin pre-fills these when the researcher selects this task. The
  // agent uses whatever the form ultimately posts, so manual overrides are
  // still respected.
  defaults: {
    trialCount: 5,
    trialDurationSeconds: 20,
    circleTargetPeriod: 5000,
    circleTargetRadius: 0.3,
    trialDisplayMode: 'avgOnly',
  },

  // ── Target trajectory ──────────────────────────────────────────────────
  // Admin's browser computes the orbit positions and publishes on the
  // LiveKit `target` topic. The server agent only opens/closes the publish
  // window. Researchers can rewrite this function to use any motion
  // equation (Lissajous, polynomial, sum-of-sinusoids, …) and the system
  // will broadcast the result to all participants automatically.
  trajectory: {
    compute(elapsedMs, params) {
      const period = typeof params.period === 'number' ? params.period : 5000;
      const radius = typeof params.radius === 'number' ? params.radius : 0.3;
      const angle = (elapsedMs / period) * 2 * Math.PI;
      return {
        x: 0.5 + radius * Math.cos(angle),
        y: 0.5 + radius * Math.sin(angle),
        shape: 'square',
      };
    },
    intervalMs: 50, // 20Hz, matches the legacy server-side rate
  },

  drawTaskLayer(p, scene, coords) {
    if (scene.target) drawTarget(p, scene.target, coords);
  },
};

export default sketch;
