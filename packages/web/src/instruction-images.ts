import type { ExperimentTaskType } from './experiments/types.js';

const MOVE_CURSOR_INSTRUCTION = 'Move the cursor with your mouse or trackpad and track the target as accurately as possible.';
const BASELINE_INSTRUCTION = 'You will first complete baseline trials using your own cursor only.';
const SHARED_CURSOR_INSTRUCTION = 'After that, you will control a shared cursor with the other participant.';
const SHARED_RATING_INSTRUCTION = 'After each trial, rate how much you felt you contributed to controlling the shared cursor.';
const FINAL_BASELINE_INSTRUCTION = 'Finally, you will complete baseline trials again using your own cursor only.';
const TASK8_SHARED_TRIAL_INSTRUCTION = 'From the next trial, you will control a shared cursor with your partner. You can only move it forward and backward, while your partner will control it left and right.';
const TASK9_GOAL_INSTRUCTION_PREFIX = 'Reach as many red targets as possible within ';
const TASK9_GOAL_INSTRUCTION_SUFFIX = ' seconds. Keep the cursor inside the target briefly to earn a point. Passing through does not count.';
const TASK9_BASELINE_INSTRUCTION = 'You will first complete baseline trials using your own cursor.';
const TASK9_SHARED_CURSOR_INSTRUCTION = 'After that, you will control a shared cursor with the other participant.';
const TASK9_SHARED_RATING_INSTRUCTION = 'After each shared-cursor trial, rate your contribution to earning the points.';
const TASK9_FINAL_BASELINE_INSTRUCTION = 'Finally, you will complete baseline trials again using your own cursor.';

function isTask9GoalInstruction(instruction: string): boolean {
  if (!instruction.startsWith(TASK9_GOAL_INSTRUCTION_PREFIX)
    || !instruction.endsWith(TASK9_GOAL_INSTRUCTION_SUFFIX)) {
    return false;
  }
  const duration = instruction.slice(
    TASK9_GOAL_INSTRUCTION_PREFIX.length,
    -TASK9_GOAL_INSTRUCTION_SUFFIX.length,
  );
  return duration.trim() !== '' && Number.isFinite(Number(duration));
}

export function getInstructionImageSrc(
  instruction: string,
  experimentTaskType?: ExperimentTaskType | null,
): string | null {
  if (experimentTaskType === 'task9') {
    if (isTask9GoalInstruction(instruction)) return '/task9-instruction1.png';
    if (instruction === TASK9_BASELINE_INSTRUCTION) return '/task9-instruction2.png';
    if (instruction === TASK9_SHARED_CURSOR_INSTRUCTION) return '/task9-instruction3.png';
    if (instruction === TASK9_SHARED_RATING_INSTRUCTION) return '/task9-instruction4.png';
    if (instruction === TASK9_FINAL_BASELINE_INSTRUCTION) return '/task9-instruction5.png';
  }
  if (instruction === MOVE_CURSOR_INSTRUCTION) {
    return experimentTaskType === 'task9' ? '/task9-instruction1.png' : '/task7-instruction1.png';
  }
  if (instruction === BASELINE_INSTRUCTION) {
    if (experimentTaskType === 'task8') return '/task8-instruction2.png';
    if (experimentTaskType === 'task9') return '/task9-instruction2.png';
    return '/task7-instruction2.png';
  }
  if (instruction === SHARED_CURSOR_INSTRUCTION) {
    if (experimentTaskType === 'task8') return '/task8-instruction3.png';
    if (experimentTaskType === 'task9') return '/task9-instruction3.png';
    return '/task7-instruction3.png';
  }
  if (instruction === SHARED_RATING_INSTRUCTION && experimentTaskType === 'cursor-control-20260706') {
    return '/task7-instruction4.png';
  }
  if (instruction === FINAL_BASELINE_INSTRUCTION) {
    if (experimentTaskType === 'task8') return '/task8-instruction4.png';
    if (experimentTaskType === 'task9') return '/task9-instruction4.png';
    return '/task7-instruction5.png';
  }
  if (instruction === TASK8_SHARED_TRIAL_INSTRUCTION && experimentTaskType === 'task8') {
    return '/task8-shared-trial-instruction.png';
  }
  return null;
}

export function getInstructionImageAlt(instruction: string): string {
  if (isTask9GoalInstruction(instruction)) {
    return 'A point-to-point task screen shows the score, cursor, and red target.';
  }
  if (instruction === TASK9_BASELINE_INSTRUCTION) {
    return 'The first baseline block uses your own cursor for three trials.';
  }
  if (instruction === TASK9_SHARED_CURSOR_INSTRUCTION) {
    return 'The shared block asks two participants to earn points together with a shared cursor.';
  }
  if (instruction === TASK9_SHARED_RATING_INSTRUCTION) {
    return 'A seven-point response scale asks participants to rate their contribution to earning points.';
  }
  if (instruction === TASK9_FINAL_BASELINE_INSTRUCTION) {
    return 'The final baseline block returns to your own cursor for two trials.';
  }
  if (instruction === MOVE_CURSOR_INSTRUCTION) {
    return 'A cursor controlled with a mouse or trackpad tracks a moving target.';
  }
  if (instruction === BASELINE_INSTRUCTION) {
    return 'The task sequence includes baseline trials using your own cursor.';
  }
  if (instruction === SHARED_CURSOR_INSTRUCTION) {
    return 'Two participants control a shared cursor together.';
  }
  if (instruction === SHARED_RATING_INSTRUCTION) {
    return 'A seven-point response scale asks participants to rate their contribution after a shared-cursor trial.';
  }
  if (instruction === TASK8_SHARED_TRIAL_INSTRUCTION) {
    return 'A shared cursor instruction explains that you control forward and backward movement while your partner controls left and right movement.';
  }
  return 'The task returns to baseline trials using your own cursor.';
}
