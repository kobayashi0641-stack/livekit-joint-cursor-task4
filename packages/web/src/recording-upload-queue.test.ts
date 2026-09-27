import assert from 'node:assert/strict';
import test from 'node:test';

test('upload queue processes one recording at a time and retries transient failures', async () => {
  let queueModule: typeof import('./recording-upload-queue') | null = null;
  try {
    queueModule = await import('./recording-upload-queue');
  } catch {
    // RED: the production queue does not exist yet.
  }
  assert.ok(queueModule, 'recording upload queue module must exist');

  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const attempts = new Map<string, number>();
  const queue = new queueModule.SequentialUploadQueue<string>(
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(value);
      const attempt = (attempts.get(value) ?? 0) + 1;
      attempts.set(value, attempt);
      await Promise.resolve();
      active -= 1;
      if (value === 'trial-1' && attempt === 1) {
        throw new Error('temporary upload failure');
      }
    },
    { maxAttempts: 3, retryDelayMs: 0 },
  );

  const first = queue.enqueue('trial-1', 'trial-1');
  const second = queue.enqueue('trial-2', 'trial-2');
  await Promise.all([first, second, queue.flush()]);

  assert.equal(maxActive, 1);
  assert.deepEqual(calls, ['trial-1', 'trial-1', 'trial-2']);
  assert.equal(queue.pendingCount, 0);
});

test('enqueue deduplicates an upload key while it is pending', async () => {
  const queueModule = await import('./recording-upload-queue');
  let calls = 0;
  const queue = new queueModule.SequentialUploadQueue<number>(
    async () => {
      calls += 1;
    },
    { maxAttempts: 2, retryDelayMs: 0 },
  );

  const first = queue.enqueue('same-trial', 1);
  const duplicate = queue.enqueue('same-trial', 1);
  assert.equal(first, duplicate);
  await queue.flush();
  assert.equal(calls, 1);
});
