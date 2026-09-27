import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getWaitingTargetFill,
  getWaitingTargetPosition,
  shouldResetParticipantStartConfirmation,
  shouldShowCursorControlWaitingPreview,
} from './waiting-target.js';

test('waiting target follows the original circular trajectory', () => {
  assert.deepEqual(getWaitingTargetPosition(0), { x: 0.63, y: 0.5 });

  const quarterTurn = getWaitingTargetPosition(1375);
  assert.ok(Math.abs(quarterTurn.x - 0.5) < 1e-12);
  assert.ok(Math.abs(quarterTurn.y - 0.63) < 1e-12);
});

test('waiting target is red until a cursor overlaps it, then turns green', () => {
  assert.equal(getWaitingTargetFill(false), '#dc2626');
  assert.equal(getWaitingTargetFill(true), '#16a34a');
});

test('waiting target remains visible when stale state says a previous experiment had started', () => {
  assert.equal(shouldShowCursorControlWaitingPreview({
    connected: true,
    isCursorControlTask: true,
    participantExperimentFlowStarted: true,
    hasActivePagedInstruction: false,
    useVirtualCursor: false,
    yesNoVisible: false,
    questionnaireVisible: false,
    questionnaireWaiting: false,
    clickAreaOverlayVisible: false,
    hasBottomBroadcast: false,
  }), true);
});

test('START confirmation survives transient waiting-screen changes until the participant pair breaks', () => {
  assert.equal(shouldResetParticipantStartConfirmation(2), false);
  assert.equal(shouldResetParticipantStartConfirmation(3), false);
  assert.equal(shouldResetParticipantStartConfirmation(1), true);
  assert.equal(shouldResetParticipantStartConfirmation(0), true);
});
