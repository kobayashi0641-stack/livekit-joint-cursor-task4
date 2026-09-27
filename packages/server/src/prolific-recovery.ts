export type ProlificSubmissionStatus =
  | 'RESERVED'
  | 'ACTIVE'
  | 'AWAITING REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'RETURNED'
  | 'TIMED-OUT'
  | 'SCREENED OUT'
  | string;

export type ProlificSubmissionCounts = {
  ACTIVE?: number;
  RESERVED?: number;
  [status: string]: number | undefined;
};

export type ProlificSubmissionDetails = {
  status: ProlificSubmissionStatus;
  studyId: string;
  participantId: string;
};

export function isJoinableProlificSubmissionStatus(status: ProlificSubmissionStatus): boolean {
  return status === 'RESERVED' || status === 'ACTIVE';
}

export interface ProlificGateway {
  pauseStudy(studyId: string): Promise<void>;
  requestReturn(submissionId: string, reasons: string[]): Promise<void>;
  getSubmissionDetails(submissionId: string): Promise<ProlificSubmissionDetails>;
  getSubmissionStatus(submissionId: string): Promise<ProlificSubmissionStatus>;
  getStudySubmissionCounts(studyId: string): Promise<ProlificSubmissionCounts>;
  startStudy(studyId: string): Promise<void>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ProlificClient implements ProlificGateway {
  constructor(
    private readonly apiToken: string,
    private readonly baseUrl = 'https://api.prolific.com/api/v1',
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async pauseStudy(studyId: string): Promise<void> {
    await this.request(`/studies/${encodeURIComponent(studyId)}/transition/`, {
      method: 'POST',
      body: JSON.stringify({ action: 'PAUSE' }),
    });
  }

  async startStudy(studyId: string): Promise<void> {
    await this.request(`/studies/${encodeURIComponent(studyId)}/transition/`, {
      method: 'POST',
      body: JSON.stringify({ action: 'START' }),
    });
  }

  async requestReturn(submissionId: string, reasons: string[]): Promise<void> {
    await this.request(`/submissions/${encodeURIComponent(submissionId)}/request-return/`, {
      method: 'POST',
      body: JSON.stringify({ request_return_reasons: reasons }),
    });
  }

  async getSubmissionStatus(submissionId: string): Promise<ProlificSubmissionStatus> {
    return (await this.getSubmissionDetails(submissionId)).status;
  }

  async getSubmissionDetails(submissionId: string): Promise<ProlificSubmissionDetails> {
    const data = await this.request<{ status?: string; study_id?: string; participant?: string }>(
      `/submissions/${encodeURIComponent(submissionId)}/`,
    );
    if (!data.status || !data.study_id || !data.participant) {
      throw new Error('Prolific submission response did not include status, study_id, and participant');
    }
    return { status: data.status, studyId: data.study_id, participantId: data.participant };
  }

  async getStudySubmissionCounts(studyId: string): Promise<ProlificSubmissionCounts> {
    return this.request<ProlificSubmissionCounts>(`/studies/${encodeURIComponent(studyId)}/submissions/counts/`);
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Prolific API ${response.status}: ${detail || response.statusText}`);
    }
    return response.json() as Promise<T>;
  }
}

type RecoverProlificStudyInput = {
  gateway: ProlificGateway;
  studyId: string;
  submissionId: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onReturnRequested?: () => Promise<void> | void;
  onProgress?: (status: ProlificSubmissionStatus, counts: ProlificSubmissionCounts) => void;
};

type RecoverProlificStudySubmissionsInput = {
  gateway: ProlificGateway;
  studyId: string;
  submissionIds: string[];
  returnReason: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onPaused?: () => Promise<void> | void;
  onReturnRequested?: () => Promise<void> | void;
  onProgress?: (statuses: ProlificSubmissionStatus[], counts: ProlificSubmissionCounts) => void;
};

export async function recoverProlificStudy({
  gateway,
  studyId,
  submissionId,
  pollIntervalMs = 15_000,
  signal,
  onReturnRequested,
  onProgress,
}: RecoverProlificStudyInput): Promise<void> {
  await recoverProlificStudySubmissions({
    gateway,
    studyId,
    submissionIds: [submissionId],
    returnReason: 'The paired experiment could not start because another participant did not join within five minutes.',
    pollIntervalMs,
    signal,
    onReturnRequested,
    onProgress: (statuses, counts) => onProgress?.(statuses[0], counts),
  });
}

export async function recoverProlificStudySubmissions({
  gateway,
  studyId,
  submissionIds,
  returnReason,
  pollIntervalMs = 15_000,
  signal,
  onPaused,
  onReturnRequested,
  onProgress,
}: RecoverProlificStudySubmissionsInput): Promise<void> {
  const uniqueSubmissionIds = [...new Set(submissionIds.filter(Boolean))];
  if (uniqueSubmissionIds.length === 0) {
    throw new Error('At least one Prolific submission is required for recovery');
  }

  await gateway.pauseStudy(studyId);
  await onPaused?.();
  await Promise.all(uniqueSubmissionIds.map((id) => gateway.requestReturn(id, [returnReason])));
  await onReturnRequested?.();

  while (!signal?.aborted) {
    const [statuses, counts] = await Promise.all([
      Promise.all(uniqueSubmissionIds.map((id) => gateway.getSubmissionStatus(id))),
      gateway.getStudySubmissionCounts(studyId),
    ]);
    onProgress?.(statuses, counts);
    const released = statuses.every((status) => status === 'RETURNED' || status === 'TIMED-OUT');
    const roomSlotsClear = (counts.ACTIVE ?? 0) === 0 && (counts.RESERVED ?? 0) === 0;
    if (released && roomSlotsClear) {
      await gateway.startStudy(studyId);
      return;
    }
    await wait(pollIntervalMs, signal);
  }
  throw new Error('Prolific recovery was aborted');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Prolific recovery was aborted'));
    }, { once: true });
  });
}
