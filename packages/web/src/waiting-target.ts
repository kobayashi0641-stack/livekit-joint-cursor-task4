const WAITING_TARGET_RADIUS = 0.13;
const WAITING_TARGET_PERIOD_MS = 5500;

export function getWaitingTargetPosition(elapsedMs: number): { x: number; y: number } {
  const angle = (Math.max(0, elapsedMs) / WAITING_TARGET_PERIOD_MS) * Math.PI * 2;
  return {
    x: 0.5 + WAITING_TARGET_RADIUS * Math.cos(angle),
    y: 0.5 + WAITING_TARGET_RADIUS * Math.sin(angle),
  };
}

export function getWaitingTargetFill(hasCursorInside: boolean): string {
  return hasCursorInside ? '#16a34a' : '#dc2626';
}

/** Keep a successful START confirmation until the connected pair actually breaks. */
export function shouldResetParticipantStartConfirmation(participantCount: number): boolean {
  return participantCount < 2;
}

type CursorControlWaitingPreviewState = {
  connected: boolean;
  isCursorControlTask: boolean;
  participantExperimentFlowStarted: boolean;
  hasActivePagedInstruction: boolean;
  useVirtualCursor: boolean;
  yesNoVisible: boolean;
  questionnaireVisible: boolean;
  questionnaireWaiting: boolean;
  clickAreaOverlayVisible: boolean;
  hasBottomBroadcast: boolean;
};

export function shouldShowCursorControlWaitingPreview(state: CursorControlWaitingPreviewState): boolean {
  return state.connected
    && state.isCursorControlTask
    // The flow-started flag can survive a server restart. The concrete UI
    // states below determine whether the participant is actually still waiting.
    && !state.hasActivePagedInstruction
    && !state.useVirtualCursor
    && !state.yesNoVisible
    && !state.questionnaireVisible
    && !state.questionnaireWaiting
    && !state.clickAreaOverlayVisible
    && !state.hasBottomBroadcast;
}
