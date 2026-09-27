type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped';

export type PointToPointAdminConfig = {
  taskType: 'task9';
  cursorControlBaselineTrials: number;
  cursorControlSharedTrials: number;
  cursorControlWashoutTrials: number;
  cursorControlAdaptationTrials: number;
  trialDurationSeconds: number;
  instructionDurationMs: number;
};

export const POINT_TO_POINT_ADMIN_DEFAULTS: PointToPointAdminConfig = {
  taskType: 'task9',
  cursorControlBaselineTrials: 3,
  cursorControlSharedTrials: 5,
  cursorControlWashoutTrials: 2,
  cursorControlAdaptationTrials: 0,
  trialDurationSeconds: 30,
  instructionDurationMs: 4000,
};

export function getInitialExperimentTaskType(
  isMainAdminPage: boolean,
  isParticipantPage: boolean,
): 'task9' | null {
  return isMainAdminPage || isParticipantPage
    ? POINT_TO_POINT_ADMIN_DEFAULTS.taskType
    : null;
}

export function shouldSyncAgentConfigFromStatus(hasLoadedInitialConfig: boolean, status: AgentStatus) {
  return !hasLoadedInitialConfig && status === 'idle';
}
