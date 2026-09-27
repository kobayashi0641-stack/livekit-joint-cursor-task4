import type { TaskSketch } from '../types';

/**
 * Non-guide tracking — participants execute a circular motion *from
 * memory* with no on-stage target or guide. The agent runs this with
 * `liveKitTaskMode: 'manual-instruction'`, so only Yes/No areas (drawn
 * by the base sketch) and broadcast hint text (DOM-overlaid by App.tsx)
 * appear during the trial.
 *
 * Consequently this script has no task-specific visuals to render —
 * the base scene already covers everything. The file exists so the
 * task is independently addressable and ready to grow custom overlays
 * (e.g. a metronome, a draw-trace) later without touching the
 * framework.
 */
const sketch: TaskSketch = {
  id: 'non-guide-tracking',
  label: 'Non-Guide Tracking',
  appliesTo: ['manual-instruction'],

  // ── Visual parameters owned by this sketch ─────────────────────────────
  // Cursor / average diameters intentionally not set — admin sliders own
  // those. Non-guide has no target or guide visuals.
  style: {
    average: { fill: '#1d4ed8' },
    yesNo: { size: 80 },
  },

  inputs: {
    cursorGain: 1.0,
  },

  defaults: {
    trialCount: 5,
    trialDurationSeconds: 20,
    trialDisplayMode: 'avgOnly',
  },

  drawTaskLayer() {
    // Intentionally empty — see file header.
  },
};

export default sketch;
