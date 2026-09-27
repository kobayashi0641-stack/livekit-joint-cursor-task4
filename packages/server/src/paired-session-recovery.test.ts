import assert from 'node:assert/strict';
import test from 'node:test';

import { ExperimentAgent } from './agent.js';
import { DEFAULT_EXPERIMENT_CONFIG } from './agent-rules.js';
import type { ProlificGateway } from './prolific-recovery.js';

async function runPostStartRecovery(reason: string) {
  const calls: string[] = [];
  const removed: string[] = [];
  const roomService = {
    listParticipants: async () => [
      { identity: 'participant-b', metadata: JSON.stringify({ role: 'experiment-participant' }) },
    ],
    sendData: async () => { calls.push('livekit-message'); },
    removeParticipant: async (_room: string, identity: string) => { removed.push(identity); },
  };
  const gateway: ProlificGateway = {
    pauseStudy: async () => { calls.push('pause'); },
    requestReturn: async (submissionId, reasons) => {
      calls.push(`request-return:${submissionId}`);
      void reasons;
    },
    getSubmissionDetails: async (submissionId) => ({
      status: 'ACTIVE',
      studyId: 'study-1',
      participantId: submissionId === 'session-a' ? 'participant-a' : 'participant-b',
    }),
    getSubmissionStatus: async (submissionId) => {
      calls.push(`status:${submissionId}`);
      return 'RETURNED';
    },
    getStudySubmissionCounts: async () => {
      calls.push('counts');
      return { ACTIVE: 0, RESERVED: 0 };
    },
    startStudy: async () => { calls.push('start'); },
  };

  const agent = new ExperimentAgent(roomService as never, 'joint-cursor-task2', gateway);
  agent.setConfig({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'cursor-control-20260706',
  });
  await agent.registerProlificSession('participant-a', 'study-1', 'session-a');
  await agent.registerProlificSession('participant-b', 'study-1', 'session-b');

  const internals = agent as unknown as {
    status: string;
    startedAt: number;
    abortController: AbortController;
    _pairedParticipantIdentities: string[];
    _pausedProlificStudyId: string | null;
    sleep: () => Promise<void>;
  };
  internals.status = 'running';
  internals.startedAt = Date.now() - 30_000;
  internals.abortController = new AbortController();
  internals._pairedParticipantIdentities = ['participant-a', 'participant-b'];
  internals._pausedProlificStudyId = 'study-1';
  internals.sleep = async () => {};

  await agent.reportParticipantWithdraw('participant-a', reason);

  assert.ok(calls.includes('livekit-message'), 'participants must be told that the task ended');
  assert.equal(calls.some((call) => call.startsWith('request-return:')), false);
  assert.equal(calls.includes('start'), false);
  assert.deepEqual(removed.sort(), ['participant-a', 'participant-b']);
  assert.equal(agent.getState().status, 'stopped');
  assert.equal(agent.getState().prolificRecovery?.status, 'paused-after-start');
}

test('post-start withdrawal keeps recruitment paused and never releases or reopens slots', async () => {
  await runPostStartRecovery('browser unload');
});

test('post-start inactivity keeps recruitment paused and never releases or reopens slots', async () => {
  await runPostStartRecovery('participant inactivity timeout');
});

test('local withdrawal immediately ends the remaining participant session without Prolific automation', async () => {
  const messages: Array<{ payload: Record<string, unknown>; destinations: string[] }> = [];
  const roomService = {
    listParticipants: async () => [
      { identity: 'participant-b', metadata: JSON.stringify({ role: 'experiment-participant' }) },
    ],
    sendData: async (
      _room: string,
      bytes: Uint8Array,
      _kind: unknown,
      options: { destinationIdentities?: string[] },
    ) => {
      messages.push({
        payload: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>,
        destinations: options.destinationIdentities ?? [],
      });
    },
  };
  const agent = new ExperimentAgent(roomService as never, 'joint-cursor-task2');
  agent.setConfig({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'cursor-control-20260706',
  });
  const internals = agent as unknown as {
    status: string;
    startedAt: number;
    abortController: AbortController;
    _pairedParticipantIdentities: string[];
  };
  internals.status = 'running';
  internals.startedAt = Date.now() - 30_000;
  internals.abortController = new AbortController();
  internals._pairedParticipantIdentities = ['participant-a', 'participant-b'];

  await agent.reportParticipantWithdraw('participant-a', 'browser unload');

  const termination = messages.find(({ payload }) => payload.type === 'participantTermination');
  assert.ok(termination, 'remaining participant must receive an immediate termination message');
  assert.deepEqual(termination.destinations, ['participant-b']);
  assert.equal(termination.payload.disposition, 'partner-compensation-review');
  assert.equal(internals.abortController.signal.aborted, true, 'the active trial must be interrupted');
});
