import type { ExperimentTask } from '../types.js';
import { generateInstructions } from './instructions.js';
import { runTrialBody } from './experiment.js';

export const circleTargetTrackingTask: ExperimentTask = {
  type: 'circle-target-tracking',
  label: 'Circle Target Tracking',
  liveKitTaskMode: 'circle-target-tracking',
  generateInstructions,
  runTrialBody,
};
