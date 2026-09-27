export const SHARED_CONTRIBUTION_QUESTION =
  'Rate your contribution to moving the shared cursor.';

export const TASK9_SHARED_CONTRIBUTION_QUESTION =
  'Rate your contribution to earning the points';

export function getSharedContributionQuestion(taskType: string | null | undefined): string {
  return taskType === 'task9'
    ? TASK9_SHARED_CONTRIBUTION_QUESTION
    : SHARED_CONTRIBUTION_QUESTION;
}

export const SHARED_CONTRIBUTION_CONSENT_COPY =
  'After each shared-cursor trial, rate your contribution to controlling the cursor.';

export const CONSENT_DATA_COLLECTION_ITEMS = [
  'Your Prolific ID',
  'Your cursor position data during the session',
  'Your questionnaire responses',
] as const;

export const SHARED_CONTRIBUTION_OPTIONS = [
  { value: 7, label: 'I did' },
  { value: 6 },
  { value: 5 },
  { value: 4, label: 'Equal contribution' },
  { value: 3 },
  { value: 2 },
  { value: 1, label: 'My partner did' },
] as const;

export const SHARED_CONTRIBUTION_SUBMIT_LABEL = 'OK';

export const SHARED_CONTRIBUTION_PANEL_MAX_WIDTH_PX = 520;
export const SHARED_CONTRIBUTION_OPTION_MIN_HEIGHT_PX = 104;
export const SHARED_CONTRIBUTION_OPTION_GAP_PX = 8;

export function getSharedContributionInputId(value: number): string {
  return `shared-contribution-${value}`;
}

export function isSharedContributionSelected(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 7;
}

export async function deliverSharedContributionResponse(
  publishToAdmin: () => Promise<void>,
  notifyAgent: () => Promise<void>,
): Promise<void> {
  await publishToAdmin();
  await notifyAgent();
}
