import type { ExperimentTask } from '../types.js';
import { generateInstructions } from './instructions.js';
import { runTrialBody } from './experiment.js';

export const nonGuideTrackingTask: ExperimentTask = {
  type: 'non-guide-tracking',
  label: 'Non-guide Tracking (Free Circular)',
  // The actual experiment runs in 'manual-instruction' task mode (no target/guide)
  liveKitTaskMode: 'manual-instruction',
  generateInstructions,
  runTrialBody,
};
