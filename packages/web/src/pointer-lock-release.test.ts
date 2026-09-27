import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForPointerLockRelease } from './pointer-lock-release.js';

class FakePointerLockDocument extends EventTarget {
  pointerLockElement: object | null = {};
}

test('questionnaire waits for the actual pointer-lock release event', async () => {
  const documentLike = new FakePointerLockDocument();
  let settled = false;
  const released = waitForPointerLockRelease(documentLike, 1000).then((value) => {
    settled = true;
    return value;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  documentLike.pointerLockElement = null;
  documentLike.dispatchEvent(new Event('pointerlockchange'));
  assert.equal(await released, true);
});

test('questionnaire proceeds immediately when pointer lock is already released', async () => {
  const documentLike = new FakePointerLockDocument();
  documentLike.pointerLockElement = null;
  assert.equal(await waitForPointerLockRelease(documentLike, 1000), true);
});
