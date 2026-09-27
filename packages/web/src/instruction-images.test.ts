import assert from 'node:assert/strict';
import test from 'node:test';

import { getInstructionImageSrc } from './instruction-images.js';

test('Task 1 shared-trial rating explanation uses the supplied fourth instruction image', () => {
  assert.equal(
    getInstructionImageSrc(
      'After each trial, rate how much you felt you contributed to controlling the shared cursor.',
      'cursor-control-20260706',
    ),
    '/task7-instruction4.png',
  );
});

test('Task 1 final baseline explanation moves to the fifth instruction image', () => {
  assert.equal(
    getInstructionImageSrc(
      'Finally, you will complete baseline trials again using your own cursor only.',
      'cursor-control-20260706',
    ),
    '/task7-instruction5.png',
  );
});

test('Task 2 point-to-point instruction pages use the supplied five images', () => {
  const pages = [
    ['Reach as many red targets as possible within 45 seconds. Keep the cursor inside the target briefly to earn a point. Passing through does not count.', '/task9-instruction1.png'],
    ['You will first complete baseline trials using your own cursor.', '/task9-instruction2.png'],
    ['After that, you will control a shared cursor with the other participant.', '/task9-instruction3.png'],
    ['After each shared-cursor trial, rate your contribution to earning the points.', '/task9-instruction4.png'],
    ['Finally, you will complete baseline trials again using your own cursor.', '/task9-instruction5.png'],
  ] as const;

  for (const [instruction, imageSrc] of pages) {
    assert.equal(getInstructionImageSrc(instruction, 'task9'), imageSrc);
  }
});
