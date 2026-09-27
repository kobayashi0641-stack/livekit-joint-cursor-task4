type PointerLockRecoveryContext = {
  experimentTaskType: string | null | undefined;
  taskMode: string | null | undefined;
  phase: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
  hasActiveTrackingTrial: boolean;
  hasActivePointToPointTrial?: boolean;
  hasInterTrialPointToPointInterval?: boolean;
  isAdmin: boolean;
};

const POINTER_LOCK_GUARDED_TASKS = new Set([
  'cursor-control-20260706',
  'task8',
  'task9',
]);

export function shouldRequireImmediatePointerLockRecovery(
  context: PointerLockRecoveryContext,
): boolean {
  return (
    context.hasActiveTrackingTrial
    || context.hasActivePointToPointTrial === true
    || context.hasInterTrialPointToPointInterval === true
  )
    && !context.isAdmin
    && context.taskMode === 'shared-single-cursor'
    && POINTER_LOCK_GUARDED_TASKS.has(context.experimentTaskType ?? '');
}
