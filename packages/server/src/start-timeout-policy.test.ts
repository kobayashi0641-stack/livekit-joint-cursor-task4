import assert from 'node:assert/strict';
import test from 'node:test';

import { ExperimentAgent } from './agent.js';
import { DEFAULT_EXPERIMENT_CONFIG } from './agent-rules.js';
import { generateRulesFromConfig } from './experiments/index.js';
import { hasParticipantStartTimedOut } from './participant-outcomes.js';
import type { ProlificGateway } from './prolific-recovery.js';

test('Task9 config uses participant START with a two-minute timeout instead of admin Start', () => {
  const rules = generateRulesFromConfig({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'task9',
  });
  const waitRule = rules.find((rule) => rule.type === 'waitForParticipants');

  assert.equal(waitRule?.type, 'waitForParticipants');
  if (waitRule?.type !== 'waitForParticipants') return;
  assert.equal(waitRule.waitForParticipantStart, true);
  assert.notEqual(waitRule.waitForAdminStart, true);
  assert.equal(waitRule.participantStartTimeoutSeconds, 120);
});

test('an explicitly tagged experiment participant is counted even when its test ID starts with debug-', async () => {
  const agent = new ExperimentAgent({
    listParticipants: async () => [
      { identity: 'debug-laptop-01', metadata: JSON.stringify({ role: 'experiment-participant' }) },
    ],
  } as never, 'joint-cursor-task2');

  await agent.refreshParticipantCount();

  assert.equal(agent.getState().participantCount, 1);
});

test('START wait expires at the configured boundary, not before it', () => {
  assert.equal(hasParticipantStartTimedOut(10_000, 129_999, 120), false);
  assert.equal(hasParticipantStartTimedOut(10_000, 130_000, 120), true);
});

test('START confirmation automatically boots Task9 when two participants and an admin are connected', async () => {
  const agent = new ExperimentAgent({
    listParticipants: async () => [
      { identity: 'participant-a', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'participant-b', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'admin:test', metadata: JSON.stringify({ role: 'admin' }) },
    ],
    sendData: async () => undefined,
  } as never, 'joint-cursor-task2');

  assert.equal(await agent.confirmParticipantStart('participant-a'), true);
  assert.equal(agent.getState().status, 'running');
  assert.equal(agent.getConfig().taskType, 'task9');
  const startGateIndex = agent.getState().rules.findIndex(
    (rule) => rule.type === 'waitForParticipants',
  );

  assert.equal(await agent.confirmParticipantStart('participant-b'), true);
  const deadline = Date.now() + 1000;
  while (agent.getState().currentStepIndex <= startGateIndex && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(agent.getState().currentStepIndex > startGateIndex, 'both START confirmations should advance to instructions');

  agent.stop();
});

test('first START is recorded immediately without waiting for the agent gate to become active', async () => {
  const agent = new ExperimentAgent({
    listParticipants: async () => [
      { identity: 'participant-a', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'participant-b', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'admin:test', metadata: JSON.stringify({ role: 'admin' }) },
    ],
    sendData: async () => undefined,
  } as never, 'joint-cursor-task2');
  const internals = agent as unknown as {
    waitForParticipantStartGate: () => Promise<void>;
    _participantStartReports: Map<string, number>;
  };
  internals.waitForParticipantStartGate = async () => {
    throw new Error('confirmation must not wait for the asynchronous agent gate');
  };

  assert.equal(await agent.confirmParticipantStart('participant-a'), true);
  assert.equal(internals._participantStartReports.has('participant-a'), true);
  agent.stop();
});

test('automatic Task1 bootstrap rejects START when the recording admin is absent', async () => {
  const agent = new ExperimentAgent({
    listParticipants: async () => [
      { identity: 'participant-a', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'participant-b', metadata: JSON.stringify({ role: 'experiment-participant' }) },
    ],
    sendData: async () => undefined,
  } as never, 'joint-cursor-task2');

  await assert.rejects(
    agent.confirmParticipantStart('participant-a'),
    /admin.*not connected/i,
  );
  assert.equal(agent.getState().status, 'idle');
});

test('START confirmation is accepted only for a connected participant during the START gate', async () => {
  const agent = new ExperimentAgent({
    listParticipants: async () => [
      { identity: 'participant-a', metadata: JSON.stringify({ role: 'experiment-participant' }) },
    ],
  } as never, 'joint-cursor-task2');
  agent.setConfig({
    ...DEFAULT_EXPERIMENT_CONFIG,
    taskType: 'cursor-control-20260706',
  });

  const internals = agent as unknown as { status: string; currentStepIndex: number };
  internals.status = 'running';
  internals.currentStepIndex = agent.getState().rules.findIndex(
    (rule) => rule.type === 'waitForParticipants',
  );

  assert.equal(await agent.reportParticipantStart('participant-a'), true);
  assert.equal(await agent.reportParticipantStart('participant-b'), false);
});

test('both START confirmations pause the Prolific study before instructions begin', async () => {
  const calls: string[] = [];
  const gateway: ProlificGateway = {
    pauseStudy: async (studyId) => { calls.push(`pause:${studyId}`); },
    requestReturn: async () => { calls.push('request-return'); },
    getSubmissionDetails: async (submissionId) => ({
      status: 'ACTIVE',
      studyId: 'study-1',
      participantId: submissionId === 'session-a' ? 'participant-a' : 'participant-b',
    }),
    getSubmissionStatus: async () => 'ACTIVE',
    getStudySubmissionCounts: async () => ({ ACTIVE: 2, RESERVED: 0 }),
    startStudy: async () => { calls.push('start'); },
  };
  const agent = new ExperimentAgent({
    listParticipants: async () => [
      { identity: 'participant-a', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'participant-b', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'admin:test', metadata: JSON.stringify({ role: 'admin' }) },
    ],
    sendData: async () => undefined,
  } as never, 'joint-cursor-task2', gateway);
  await agent.registerProlificSession('participant-a', 'study-1', 'session-a');
  await agent.registerProlificSession('participant-b', 'study-1', 'session-b');

  assert.equal(await agent.confirmParticipantStart('participant-a'), true);
  assert.equal(await agent.confirmParticipantStart('participant-b'), true);
  const deadline = Date.now() + 1000;
  while (!calls.some((call) => call.startsWith('pause:')) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  assert.deepEqual(calls, ['pause:study-1']);
  assert.equal(agent.getState().prolificRecovery?.status, 'paused-after-start');
  agent.stop();
});

test('a participant who joins during Prolific recovery is asked to return and disconnected', async () => {
  const calls: string[] = [];
  const gateway: ProlificGateway = {
    pauseStudy: async () => { calls.push('pause'); },
    requestReturn: async (submissionId) => { calls.push(`request-return:${submissionId}`); },
    getSubmissionDetails: async (submissionId) => ({
      status: 'ACTIVE',
      studyId: 'study-1',
      participantId: submissionId === 'session-b' ? 'participant-b' : 'participant-a',
    }),
    getSubmissionStatus: async () => 'ACTIVE',
    getStudySubmissionCounts: async () => ({ ACTIVE: 1, RESERVED: 0 }),
    startStudy: async () => { calls.push('start'); },
  };
  const agent = new ExperimentAgent({
    sendData: async () => { calls.push('termination-message'); },
    removeParticipant: async (_roomName: string, identity: string) => {
      calls.push(`disconnect:${identity}`);
    },
  } as never, 'joint-cursor-task2', gateway);
  const internals = agent as unknown as {
    _prolificRecovery: { status: 'waiting-for-release'; identity?: string };
    _prolificSessions: Map<string, { studyId: string; submissionId: string }>;
  };
  internals._prolificRecovery = { status: 'waiting-for-release', identity: 'participant-a' };
  internals._prolificSessions.set('participant-a', {
    studyId: 'study-1',
    submissionId: 'session-a',
  });

  await agent.registerProlificSession('participant-b', 'study-1', 'session-b');

  assert.ok(calls.includes('request-return:session-b'));
  assert.ok(calls.includes('termination-message'));
  assert.ok(calls.includes('disconnect:participant-b'));
  assert.equal(internals._prolificSessions.has('participant-b'), false);
  assert.equal(agent.getState().terminationOutcomes?.at(-1)?.identity, 'participant-b');
  assert.equal(agent.getState().terminationOutcomes?.at(-1)?.disposition, 'return-no-payment');
});
