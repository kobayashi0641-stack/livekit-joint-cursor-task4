import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTask9AcquisitionEvent,
  buildTask9TargetStateReport,
  snapshotTask9ParticipantTargetPairs,
  type Task9TargetStateReport,
} from './recording.js';

test('builds a participant target-pair report with both indices and positions', () => {
  const report = buildTask9TargetStateReport('participant-a', {
    trialKey: 'trial-4',
    trialNumber: 4,
    phase: 'baseline',
    sequence: 2,
    score: 2,
    previousTargetIndex: 3,
    targetIndices: [6, 9],
    targetPositions: [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }],
    targetPresentedAt: 1200,
  }, 1250);

  assert.deepEqual(report, {
    type: 'task9TargetState',
    identity: 'participant-a',
    trialKey: 'trial-4',
    trialNumber: 4,
    phase: 'baseline',
    sequence: 2,
    score: 2,
    previousTargetIndex: 3,
    targetIndices: [6, 9],
    targetPositions: [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.7 }],
    targetPresentedAt: 1200,
    timestamp: 1250,
  });
});

test('snapshots distinct solo target pairs for each participant', () => {
  const reports = new Map<string, Task9TargetStateReport>([
    ['participant-a', buildTask9TargetStateReport('participant-a', {
      trialKey: 'solo', trialNumber: 1, phase: 'baseline', sequence: 1, score: 1,
      previousTargetIndex: 2, targetIndices: [4, 7],
      targetPositions: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], targetPresentedAt: 1000,
    }, 1010)!],
    ['participant-b', buildTask9TargetStateReport('participant-b', {
      trialKey: 'solo', trialNumber: 1, phase: 'baseline', sequence: 3, score: 3,
      previousTargetIndex: 5, targetIndices: [8, 11],
      targetPositions: [{ x: 0.6, y: 0.7 }, { x: 0.8, y: 0.9 }], targetPresentedAt: 1020,
    }, 1030)!],
  ]);

  assert.deepEqual(
    snapshotTask9ParticipantTargetPairs(['participant-a', 'participant-b'], reports),
    {
      'participant-a': {
        trialKey: 'solo', trialNumber: 1, phase: 'baseline', sequence: 1, score: 1,
        previousTargetIndex: 2, targetIndices: [4, 7],
        targetPositions: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], targetPresentedAt: 1000,
      },
      'participant-b': {
        trialKey: 'solo', trialNumber: 1, phase: 'baseline', sequence: 3, score: 3,
        previousTargetIndex: 5, targetIndices: [8, 11],
        targetPositions: [{ x: 0.6, y: 0.7 }, { x: 0.8, y: 0.9 }], targetPresentedAt: 1020,
      },
    },
  );
});

test('uses the authoritative shared pair for participants missing an individual report', () => {
  const shared = buildTask9TargetStateReport('shared', {
    trialKey: 'shared', trialNumber: 5, phase: 'shared', sequence: 4, score: 4,
    previousTargetIndex: 6, targetIndices: [10, 12],
    targetPositions: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }], targetPresentedAt: 2000,
  }, 2010)!;

  assert.deepEqual(
    snapshotTask9ParticipantTargetPairs(
      ['participant-a', 'participant-b'],
      new Map([['shared', shared]]),
    ),
    {
      'participant-a': {
        trialKey: 'shared', trialNumber: 5, phase: 'shared', sequence: 4, score: 4,
        previousTargetIndex: 6, targetIndices: [10, 12],
        targetPositions: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }], targetPresentedAt: 2000,
      },
      'participant-b': {
        trialKey: 'shared', trialNumber: 5, phase: 'shared', sequence: 4, score: 4,
        previousTargetIndex: 6, targetIndices: [10, 12],
        targetPositions: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }], targetPresentedAt: 2000,
      },
    },
  );
});

test('builds a participant acquisition event with offered, chosen, unchosen and next targets', () => {
  const event = buildTask9AcquisitionEvent('participant-a', {
    trialKey: 'trial-2', trialNumber: 2, phase: 'baseline', sequence: 1, score: 2,
    targetIndices: [4, 7], targetIndex: 7, unchosenTargetIndex: 4,
    nextTargetIndices: [9, 11], nextTargetIndex: 9,
    targetPositions: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }],
    targetPosition: { x: 0.8, y: 0.8 }, unchosenTargetPosition: { x: 0.2, y: 0.2 },
    nextTargetPositions: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.7 }],
    targetPresentedAt: 3000, acquiredAt: 3450, movementTimeMs: 450, dwellMs: 50,
  }, 3460);

  assert.equal(event?.identity, 'participant-a');
  assert.deepEqual(event?.targetIndices, [4, 7]);
  assert.deepEqual(event?.targetPositions, [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }]);
  assert.equal(event?.targetIndex, 7);
  assert.equal(event?.unchosenTargetIndex, 4);
  assert.deepEqual(event?.nextTargetIndices, [9, 11]);
  assert.equal(event?.movementTimeMs, 450);
  assert.equal(event?.participantTimestamp, 3450);
  assert.equal(event?.timestamp, 3460);
});

