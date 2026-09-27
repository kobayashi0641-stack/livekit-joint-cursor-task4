/**
 * Trial body for Group Circle Target Tracking.
 *
 * The per-trial behavior is identical to single-group circle tracking — the
 * only difference is that participants see the average cursor of their *group*
 * (filtered client-side based on `setGroupAssignments`). The group composition
 * and the re-shuffle / merge logic live in `index.ts → generateTrialSequence`.
 */

export { runTrialBody } from '../circle-target-tracking/experiment.js';
