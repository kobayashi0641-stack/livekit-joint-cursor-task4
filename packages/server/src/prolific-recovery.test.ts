import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isJoinableProlificSubmissionStatus,
  ProlificClient,
  recoverProlificStudy,
  recoverProlificStudySubmissions,
  type ProlificGateway,
} from './prolific-recovery.js';

test('only reserved or active Prolific submissions may join the experiment', () => {
  assert.equal(isJoinableProlificSubmissionStatus('RESERVED'), true);
  assert.equal(isJoinableProlificSubmissionStatus('ACTIVE'), true);
  assert.equal(isJoinableProlificSubmissionStatus('RETURNED'), false);
  assert.equal(isJoinableProlificSubmissionStatus('TIMED-OUT'), false);
  assert.equal(isJoinableProlificSubmissionStatus('APPROVED'), false);
});

test('recovery pauses, requests return, waits for release, and restarts without approving payment', async () => {
  const calls: string[] = [];
  let statusChecks = 0;
  const gateway: ProlificGateway = {
    pauseStudy: async () => { calls.push('pause'); },
    requestReturn: async () => { calls.push('request-return'); },
    getSubmissionDetails: async () => ({ status: 'ACTIVE', studyId: 'study-1', participantId: 'participant-1' }),
    getSubmissionStatus: async () => {
      calls.push('submission-status');
      statusChecks += 1;
      return statusChecks === 1 ? 'ACTIVE' : 'RETURNED';
    },
    getStudySubmissionCounts: async () => {
      calls.push('counts');
      return statusChecks === 1 ? { ACTIVE: 1, RESERVED: 0 } : { ACTIVE: 0, RESERVED: 0 };
    },
    startStudy: async () => { calls.push('start'); },
  };

  await recoverProlificStudy({
    gateway,
    studyId: 'study-1',
    submissionId: 'session-1',
    pollIntervalMs: 0,
    onReturnRequested: async () => { calls.push('disconnect'); },
  });

  assert.deepEqual(calls, [
    'pause',
    'request-return',
    'disconnect',
    'submission-status',
    'counts',
    'submission-status',
    'counts',
    'start',
  ]);
});

test('client uses only pause, return-request, read, and start Prolific endpoints', async () => {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const path = String(url);
    if (path.endsWith('/submissions/session-1/')) {
      return new Response(JSON.stringify({ status: 'RETURNED', study_id: 'study-1', participant: 'participant-1' }), { status: 200 });
    }
    if (path.endsWith('/studies/study-1/submissions/counts/')) {
      return new Response(JSON.stringify({ ACTIVE: 0, RESERVED: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const client = new ProlificClient('secret', 'https://api.prolific.test/api/v1', fetchImpl);

  await client.pauseStudy('study-1');
  await client.requestReturn('session-1', ['Partner did not join within five minutes.']);
  assert.deepEqual(await client.getSubmissionDetails('session-1'), {
    status: 'RETURNED',
    studyId: 'study-1',
    participantId: 'participant-1',
  });
  assert.deepEqual(await client.getStudySubmissionCounts('study-1'), { ACTIVE: 0, RESERVED: 0 });
  await client.startStudy('study-1');

  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ['POST', 'https://api.prolific.test/api/v1/studies/study-1/transition/'],
    ['POST', 'https://api.prolific.test/api/v1/submissions/session-1/request-return/'],
    ['GET', 'https://api.prolific.test/api/v1/submissions/session-1/'],
    ['GET', 'https://api.prolific.test/api/v1/studies/study-1/submissions/counts/'],
    ['POST', 'https://api.prolific.test/api/v1/studies/study-1/transition/'],
  ]);
  assert.equal(JSON.parse(requests[0].body ?? '{}').action, 'PAUSE');
  assert.equal(JSON.parse(requests[4].body ?? '{}').action, 'START');
});

test('paired recovery requests returns for both submissions before waiting and reopening recruitment', async () => {
  const calls: string[] = [];
  const statuses = new Map([
    ['session-a', ['ACTIVE', 'RETURNED']],
    ['session-b', ['ACTIVE', 'RETURNED']],
  ]);
  let statusRound = 0;
  const gateway: ProlificGateway = {
    pauseStudy: async () => { calls.push('pause'); },
    requestReturn: async (submissionId) => { calls.push(`request-return:${submissionId}`); },
    getSubmissionDetails: async () => ({ status: 'ACTIVE', studyId: 'study-1', participantId: 'participant-1' }),
    getSubmissionStatus: async (submissionId) => {
      calls.push(`status:${submissionId}`);
      const values = statuses.get(submissionId) ?? ['ACTIVE'];
      return values[Math.min(statusRound, values.length - 1)];
    },
    getStudySubmissionCounts: async () => {
      calls.push('counts');
      const counts = statusRound === 0 ? { ACTIVE: 2, RESERVED: 0 } : { ACTIVE: 0, RESERVED: 0 };
      statusRound += 1;
      return counts;
    },
    startStudy: async () => { calls.push('start'); },
  };

  await recoverProlificStudySubmissions({
    gateway,
    studyId: 'study-1',
    submissionIds: ['session-a', 'session-b'],
    returnReason: 'START confirmation timeout.',
    pollIntervalMs: 0,
  });

  assert.deepEqual(calls.slice(0, 3), [
    'pause',
    'request-return:session-a',
    'request-return:session-b',
  ]);
  assert.equal(calls.at(-1), 'start');
});
