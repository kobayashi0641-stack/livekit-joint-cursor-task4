import assert from 'node:assert/strict';
import test from 'node:test';

import * as cleanup from './end-session-cleanup.js';

test('end-session safety cleanup waits two minutes and kicks only the completed pair', async () => {
  const removed: string[] = [];
  let scheduledDelay = -1;
  let scheduledTask: (() => Promise<void>) | undefined;
  const roomService = {
    listParticipants: async () => [
      { identity: 'participant-a', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'participant-b', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'participant-new', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'admin:main', metadata: JSON.stringify({ role: 'admin' }) },
    ],
    removeParticipant: async (_room: string, identity: string) => { removed.push(identity); },
  };

  const policy = cleanup as unknown as {
    END_SESSION_FORCE_DISCONNECT_DELAY_MS?: number;
    scheduleEndSessionParticipantCleanup?: (options: {
      roomService: typeof roomService;
      roomName: string;
      participantIdentities: string[];
      schedule: (task: () => Promise<void>, delay: number) => unknown;
    }) => void;
  };

  assert.equal(policy.END_SESSION_FORCE_DISCONNECT_DELAY_MS, 120_000);
  assert.equal(typeof policy.scheduleEndSessionParticipantCleanup, 'function');
  if (!policy.scheduleEndSessionParticipantCleanup) return;

  policy.scheduleEndSessionParticipantCleanup({
    roomService,
    roomName: 'room-1',
    participantIdentities: ['participant-a', 'participant-b'],
    schedule: (task, delay) => {
      scheduledTask = task;
      scheduledDelay = delay;
      return {};
    },
  });

  assert.equal(scheduledDelay, 120_000);
  assert.equal(typeof scheduledTask, 'function');
  await scheduledTask?.();
  assert.deepEqual(removed.sort(), ['participant-a', 'participant-b']);
});

test('immediate completion disconnect ignores identities outside the completed pair', async () => {
  const removed: string[] = [];
  const roomService = {
    listParticipants: async () => [
      { identity: 'participant-a', metadata: JSON.stringify({ role: 'experiment-participant' }) },
      { identity: 'participant-new', metadata: JSON.stringify({ role: 'experiment-participant' }) },
    ],
    removeParticipant: async (_room: string, identity: string) => { removed.push(identity); },
  };
  const disconnect = (
    cleanup as unknown as {
      disconnectCompletedParticipant?: (options: {
        roomService: typeof roomService;
        roomName: string;
        identity: string;
        completedParticipantIdentities: string[];
      }) => Promise<boolean>;
    }
  ).disconnectCompletedParticipant;

  assert.equal(typeof disconnect, 'function');
  if (!disconnect) return;
  assert.equal(await disconnect({
    roomService,
    roomName: 'room-1',
    identity: 'participant-new',
    completedParticipantIdentities: ['participant-a', 'participant-b'],
  }), false);
  assert.equal(await disconnect({
    roomService,
    roomName: 'room-1',
    identity: 'participant-a',
    completedParticipantIdentities: ['participant-a', 'participant-b'],
  }), true);
  assert.deepEqual(removed, ['participant-a']);
});
