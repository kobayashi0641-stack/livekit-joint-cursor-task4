import { drawTarget } from '../shared/draw';
import type { TaskSketch } from '../types';

/**
 * Reaching — visuomotor rotation paradigm. A static circular target
 * sits at a fixed position (default (0.5, 0.2)). The displayed average
 * cursor starts at (0.5, 0.8) thanks to the avg-cursor offset paradigm
 * (see CLAUDE.md). The trial advances when the displayed avg crosses
 * within `reachingThreshold` of the target — detection is server-side,
 * but the visual stays the same: one red circle until it's hit.
 *
 * Across baseline → adaptation → washout phases the per-trial
 * `cursorRotationDeg` changes; the rotation is applied to participants'
 * pointer-locked input deltas (see `handlePointerMove`), so the *cursor*
 * curves while this script's static target stays put.
 */
const sketch: TaskSketch = {
  id: 'reaching',
  label: 'Reaching',
  appliesTo: ['reaching'],

  // ── Visual parameters owned by this sketch ─────────────────────────────
  // Cursor / average / target sizes intentionally not set — admin sliders
  // own those. The agent owns the yellow→red transition (via
  // scene.target.color set by the server's publishStaticTarget). This
  // `target.fill` only kicks in when scene.target.color is undefined — a
  // defensive fallback.
  style: {
    average: { fill: '#1d4ed8' },
    target: { shape: 'circle', fill: '#ef4444' },
    yesNo: { size: 80 },
  },

  inputs: {
    cursorGain: 1.0,
  },

  // Target/start positions, hit threshold, phase counts, rotation angle —
  // all sketch-declared. AgentAdmin's reaching form pre-fills from these.
  // Values intentionally mirror server `DEFAULT_EXPERIMENT_CONFIG` so that
  // switching to this task in AgentAdmin doesn't silently change settings
  // a researcher had configured for another task. Adjust freely here to
  // change the per-task defaults.
  defaults: {
    trialCount: 5,
    trialDurationSeconds: 20,
    reachingTargetX: 0.5,
    reachingTargetY: 0.2,
    reachingStartX: 0.5,
    reachingStartY: 0.8,
    reachingThreshold: 0.05,
    reachingPreTrials: 5,
    reachingRotationTrials: 10,
    reachingPostTrials: 5,
    reachingRotationDeg: 15,
    trialDisplayMode: 'avgOnly',
  },

  // ── Hit detection ──────────────────────────────────────────────────────
  // Admin's browser polls this predicate at `intervalMs`. When it returns
  // true (displayed avg cursor within reachingThreshold of the target), the
  // admin client POSTs a 'reach' sketchEvent to the server, which unblocks
  // the agent's `waitForSketchEvent('reach', timeoutMs)` and advances the
  // trial.
  //
  // Researchers can rewrite this to any geometry — rectangular goals
  // (`|dx| < w && |dy| < h`), polygon containment, time-conditional
  // (must remain inside for N ms), etc. — without server changes.
  hit: {
    detect(ctx) {
      const avg = ctx.averageCursor;
      const target = ctx.target;
      if (!avg || !target) return false;
      // `threshold` is passed by the agent via the control message
      // params, sourced from `ExperimentConfig.reachingThreshold`.
      const threshold = typeof ctx.params.threshold === 'number'
        ? ctx.params.threshold
        : 0.05;
      const dx = avg.x - target.x;
      const dy = avg.y - target.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      return dist <= threshold;
    },
    eventName: 'reach',
    intervalMs: 50, // 20Hz
  },

  drawTaskLayer(p, scene, coords) {
    if (scene.target) drawTarget(p, scene.target, coords);
  },
};

export default sketch;
