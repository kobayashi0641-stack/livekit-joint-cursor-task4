import type { ExperimentTask } from '../types.js';
import { generateInstructions } from './instructions.js';
import { runTrialBody } from './experiment.js';

export const guideTrackingTask: ExperimentTask = {
  type: 'guide-tracking',
  label: 'Guide Tracking',
  liveKitTaskMode: 'guide-tracking',
  generateInstructions,
  runTrialBody,
};
