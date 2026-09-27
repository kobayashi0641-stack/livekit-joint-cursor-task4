export type ParticipantDisposition = 'return-no-payment' | 'partner-compensation-review';

export type ParticipantTerminationOutcome = {
  identity: string;
  disposition: ParticipantDisposition;
  reason: string;
  elapsedSeconds: number;
};

type BuildParticipantTerminationOutcomesInput = {
  participantIdentities: string[];
  responsibleIdentity: string;
  reason: string;
  elapsedSeconds: number;
};

export function buildParticipantTerminationOutcomes({
  participantIdentities,
  responsibleIdentity,
  reason,
  elapsedSeconds,
}: BuildParticipantTerminationOutcomesInput): ParticipantTerminationOutcome[] {
  const identities = [...new Set(participantIdentities.filter(Boolean))];
  const safeElapsedSeconds = Math.max(0, Math.floor(elapsedSeconds));

  return identities.map((identity) => ({
    identity,
    disposition: identity === responsibleIdentity
      ? 'return-no-payment'
      : 'partner-compensation-review',
    reason,
    elapsedSeconds: safeElapsedSeconds,
  }));
}

export function buildNoMatchTerminationOutcome(
  identity: string,
  elapsedSeconds: number,
): ParticipantTerminationOutcome {
  return {
    identity,
    disposition: 'return-no-payment',
    reason: 'partner did not join within 5 minutes',
    elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
  };
}

type BuildStartTimeoutTerminationOutcomesInput = {
  participantIdentities: string[];
  elapsedSeconds: number;
};

export function buildStartTimeoutTerminationOutcomes({
  participantIdentities,
  elapsedSeconds,
}: BuildStartTimeoutTerminationOutcomesInput): ParticipantTerminationOutcome[] {
  const identities = [...new Set(participantIdentities.filter(Boolean))];
  const safeElapsedSeconds = Math.max(0, Math.floor(elapsedSeconds));

  return identities.map((identity) => ({
    identity,
    disposition: 'return-no-payment',
    reason: 'start confirmation timeout',
    elapsedSeconds: safeElapsedSeconds,
  }));
}

export function hasParticipantStartTimedOut(
  startedAt: number,
  now: number,
  timeoutSeconds: number,
): boolean {
  return now - startedAt >= Math.max(0, timeoutSeconds) * 1000;
}
