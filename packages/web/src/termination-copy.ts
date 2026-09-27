export type ParticipantTerminationDisposition = 'return-no-payment' | 'partner-compensation-review';

export type ParticipantTerminationKind =
  | 'no-match'
  | 'start-timeout-no-payment'
  | 'responsible'
  | 'partner';

export const INSTRUCTION_BACK_LABEL = 'Back';
export const PARTICIPANT_WAITING_CURSOR_NOTICE =
  'Once you have been matched with another participant, the START button will appear. Click it to begin the experiment.';

const PRE_EXPERIMENT_RETURN_NOTICE =
  'After this submission is returned, you cannot rejoin this experiment session. ' +
  'Future recruitment rounds for this experiment will be offered, and we would be grateful if you would consider participating in a future session.';

export function getPreExperimentReturnNotice(kind: ParticipantTerminationKind): string | null {
  return kind === 'no-match' || kind === 'start-timeout-no-payment'
    ? PRE_EXPERIMENT_RETURN_NOTICE
    : null;
}

export function classifyParticipantTermination(outcome: {
  disposition: ParticipantTerminationDisposition;
  reason: string;
}): ParticipantTerminationKind {
  if (outcome.reason === 'partner did not join within 5 minutes') return 'no-match';
  if (outcome.reason === 'start confirmation timeout') return 'start-timeout-no-payment';
  return outcome.disposition === 'return-no-payment' ? 'responsible' : 'partner';
}

export function getParticipantStartPrompt(
  participantCount: number,
  startConfirmed: boolean,
  startError?: string | null,
): string {
  if (startError) return startError;
  if (participantCount < 2) return 'Please wait for the other participant to join...';
  if (startConfirmed) return 'START confirmed. Waiting for the other participant...';
  return 'Both participants have joined. Please press START to begin the experiment.';
}

export function getParticipantStartButtonLabel(confirmed: boolean, pending: boolean): string {
  if (confirmed) return 'Confirmed...';
  if (pending) return 'CONFIRMING...';
  return 'START';
}

export async function submitParticipantStart(
  fetcher: typeof fetch,
  serverUrl: string,
  identity: string,
): Promise<void> {
  const baseUrl = serverUrl.replace(/\/$/, '');
  const response = await fetcher(`${baseUrl}/agent/participant-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity }),
  });
  if (response.ok) return;

  const payload = await response.json().catch(() => ({})) as { message?: unknown };
  const message = typeof payload.message === 'string'
    ? payload.message
    : 'Could not confirm START. Please try again.';
  throw new Error(message);
}
