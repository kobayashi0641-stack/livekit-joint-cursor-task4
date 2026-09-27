import assert from 'node:assert/strict';
import test from 'node:test';

import * as completion from './completion-disconnect.js';

test('admin completion disconnects LiveKit without participant redirect work', async () => {
  const calls: string[] = [];
  const finish = (
    completion as unknown as {
      finishAdminSession?: (options: {
        disconnect: () => Promise<void>;
      }) => Promise<void>;
    }
  ).finishAdminSession;

  assert.equal(typeof finish, 'function');
  if (!finish) return;
  await finish({
    disconnect: async () => { calls.push('disconnect'); },
  });

  assert.deepEqual(calls, ['disconnect']);
});

test('participant completion notifies the server, disconnects LiveKit, then redirects', async () => {
  const calls: string[] = [];
  const finish = (
    completion as unknown as {
      finishParticipantSession?: (options: {
        notifyServer: () => Promise<void>;
        disconnect: () => Promise<void>;
        navigate: (url: string) => void;
        completionUrl: string;
      }) => Promise<void>;
    }
  ).finishParticipantSession;

  assert.equal(typeof finish, 'function');
  if (!finish) return;
  await finish({
    notifyServer: async () => { calls.push('notify'); },
    disconnect: async () => { calls.push('disconnect'); },
    navigate: (url) => { calls.push(`navigate:${url}`); },
    completionUrl: 'https://example.test/complete',
  });

  assert.deepEqual(calls, [
    'notify',
    'disconnect',
    'navigate:https://example.test/complete',
  ]);
});

test('redirect still occurs when LiveKit disconnect fails', async () => {
  const calls: string[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  const finish = (
    completion as unknown as {
      finishParticipantSession?: (options: {
        notifyServer: () => Promise<void>;
        disconnect: () => Promise<void>;
        navigate: (url: string) => void;
        completionUrl: string;
      }) => Promise<void>;
    }
  ).finishParticipantSession;

  assert.equal(typeof finish, 'function');
  if (!finish) return;
  try {
    await finish({
      notifyServer: async () => { calls.push('notify'); },
      disconnect: async () => { calls.push('disconnect'); throw new Error('disconnect failed'); },
      navigate: (url) => { calls.push(`navigate:${url}`); },
      completionUrl: 'https://example.test/complete',
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls, [
    'notify',
    'disconnect',
    'navigate:https://example.test/complete',
  ]);
});
