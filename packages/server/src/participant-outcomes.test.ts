import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNoMatchTerminationOutcome,
  buildParticipantTerminationOutcomes,
  buildStartTimeoutTerminationOutcomes,
} from './participant-outcomes.js';

test('page withdrawal marks the leaver for return and the partner for compensation review', () => {
  const outcomes = buildParticipantTerminationOutcomes({
    participantIdentities: ['participant-a', 'participant-b'],
    responsibleIdentity: 'participant-a',
    reason: 'browser unload',
    elapsedSeconds: 420,
  });

  assert.deepEqual(outcomes, [
    {
      identity: 'participant-a',
      disposition: 'return-no-payment',
      reason: 'browser unload',
      elapsedSeconds: 420,
    },
    {
      identity: 'participant-b',
      disposition: 'partner-compensation-review',
      reason: 'browser unload',
      elapsedSeconds: 420,
    },
  ]);
});

test('inactivity marks only the inactive participant for return without payment', () => {
  const outcomes = buildParticipantTerminationOutcomes({
    participantIdentities: ['participant-a', 'participant-b'],
    responsibleIdentity: 'participant-b',
    reason: 'participant inactivity timeout',
    elapsedSeconds: 121,
  });

  assert.equal(outcomes.find((outcome) => outcome.identity === 'participant-b')?.disposition, 'return-no-payment');
  assert.equal(outcomes.find((outcome) => outcome.identity === 'participant-a')?.disposition, 'partner-compensation-review');
});

test('duplicate identities are removed before outcomes are generated', () => {
  const outcomes = buildParticipantTerminationOutcomes({
    participantIdentities: ['participant-a', 'participant-a', 'participant-b'],
    responsibleIdentity: 'participant-a',
    reason: 'page hide',
    elapsedSeconds: 12,
  });

  assert.deepEqual(outcomes.map((outcome) => outcome.identity), ['participant-a', 'participant-b']);
});

test('five-minute no-match timeout requests a return without standard payment', () => {
  assert.deepEqual(buildNoMatchTerminationOutcome('participant-a', 300), {
    identity: 'participant-a',
    disposition: 'return-no-payment',
    reason: 'partner did not join within 5 minutes',
    elapsedSeconds: 300,
  });
});

test('START timeout requests return without payment even when one participant pressed START', () => {
  assert.deepEqual(buildStartTimeoutTerminationOutcomes({
    participantIdentities: ['participant-a', 'participant-b'],
    elapsedSeconds: 120,
  }), [
    {
      identity: 'participant-a',
      disposition: 'return-no-payment',
      reason: 'start confirmation timeout',
      elapsedSeconds: 120,
    },
    {
      identity: 'participant-b',
      disposition: 'return-no-payment',
      reason: 'start confirmation timeout',
      elapsedSeconds: 120,
    },
  ]);
});

test('START timeout marks both participants for return without payment when neither pressed START', () => {
  const outcomes = buildStartTimeoutTerminationOutcomes({
    participantIdentities: ['participant-a', 'participant-b'],
    elapsedSeconds: 120,
  });

  assert.deepEqual(outcomes.map(({ identity, disposition }) => ({ identity, disposition })), [
    { identity: 'participant-a', disposition: 'return-no-payment' },
    { identity: 'participant-b', disposition: 'return-no-payment' },
  ]);
});
