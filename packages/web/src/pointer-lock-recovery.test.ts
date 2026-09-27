import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { shouldRequireImmediatePointerLockRecovery } from './pointer-lock-recovery.js';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('Task 1 requires immediate pointer-lock recovery during every tracking phase', () => {
  for (const phase of ['baseline', 'shared', 'washout'] as const) {
    assert.equal(
      shouldRequireImmediatePointerLockRecovery({
        experimentTaskType: 'cursor-control-20260706',
        taskMode: 'shared-single-cursor',
        phase,
        hasActiveTrackingTrial: true,
        isAdmin: false,
      }),
      true,
    );
  }
});

test('pointer-lock recovery is not shown outside active participant tracking', () => {
  const base = {
    experimentTaskType: 'cursor-control-20260706',
    taskMode: 'shared-single-cursor',
    phase: 'baseline' as const,
    hasActiveTrackingTrial: true,
    isAdmin: false,
  };

  assert.equal(shouldRequireImmediatePointerLockRecovery({ ...base, hasActiveTrackingTrial: false }), false);
  assert.equal(shouldRequireImmediatePointerLockRecovery({ ...base, isAdmin: true }), false);
  assert.equal(shouldRequireImmediatePointerLockRecovery({ ...base, taskMode: 'manual-instruction' }), false);
});

test('Task9 point-to-point trials trigger Esc recovery without the legacy tracking event', () => {
  assert.equal(
    shouldRequireImmediatePointerLockRecovery({
      experimentTaskType: 'task9',
      taskMode: 'shared-single-cursor',
      phase: 'baseline',
      hasActiveTrackingTrial: false,
      hasActivePointToPointTrial: true,
      isAdmin: false,
    }),
    true,
  );
});

test('Task9 requires Esc recovery during the inter-trial completion interval', () => {
  assert.equal(
    shouldRequireImmediatePointerLockRecovery({
      experimentTaskType: 'task9',
      taskMode: 'shared-single-cursor',
      phase: 'baseline',
      hasActiveTrackingTrial: false,
      hasActivePointToPointTrial: false,
      hasInterTrialPointToPointInterval: true,
      isAdmin: false,
    }),
    true,
  );
});

test('Task9 does not force pointer lock while the shared-trial questionnaire is open', () => {
  assert.equal(
    shouldRequireImmediatePointerLockRecovery({
      experimentTaskType: 'task9',
      taskMode: 'shared-single-cursor',
      phase: 'shared',
      hasActiveTrackingTrial: false,
      hasActivePointToPointTrial: false,
      hasInterTrialPointToPointInterval: false,
      isAdmin: false,
    }),
    false,
  );
});

test('the participant who remains locked does not see the partner lock-wait message during tracking', () => {
  assert.match(
    appSource,
    /if \(allParticipantsPointerLocked \|\| suppressLockWaitMessage\) \{\s*return null;/,
  );
});
