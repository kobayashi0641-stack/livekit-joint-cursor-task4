import assert from 'node:assert/strict';
import test from 'node:test';

import * as terminationCopy from './termination-copy.js';

const {
  classifyParticipantTermination,
  getParticipantStartPrompt,
} = terminationCopy;

test('START timeout uses the same pre-experiment no-payment outcome for every participant', () => {
  assert.equal(classifyParticipantTermination({
    disposition: 'partner-compensation-review',
    reason: 'start confirmation timeout',
  }), 'start-timeout-no-payment');
});

test('participant who pressed START is told that confirmation was recorded', () => {
  assert.equal(
    getParticipantStartPrompt(2, true),
    'START confirmed. Waiting for the other participant...',
  );
});

test('START button remains visible as Confirmed while waiting for the partner', () => {
  const getLabel = (
    terminationCopy as unknown as {
      getParticipantStartButtonLabel?: (confirmed: boolean, pending: boolean) => string;
    }
  ).getParticipantStartButtonLabel;
  assert.equal(typeof getLabel, 'function');
  if (!getLabel) return;
  assert.equal(getLabel(false, false), 'START');
  assert.equal(getLabel(false, true), 'CONFIRMING...');
  assert.equal(getLabel(true, false), 'Confirmed...');
});

test('waiting screen explains how to start after matching', () => {
  const notice = (
    terminationCopy as unknown as { PARTICIPANT_WAITING_CURSOR_NOTICE?: string }
  ).PARTICIPANT_WAITING_CURSOR_NOTICE;

  assert.equal(
    notice,
    'Once you have been matched with another participant, the START button will appear. Click it to begin the experiment.',
  );
});

test('pre-experiment returns explain that this session cannot be rejoined but future recruitment is possible', () => {
  const getPreExperimentReturnNotice = (
    terminationCopy as unknown as {
      getPreExperimentReturnNotice?: (kind: string) => string | null;
    }
  ).getPreExperimentReturnNotice;
  assert.equal(typeof getPreExperimentReturnNotice, 'function');
  if (!getPreExperimentReturnNotice) return;
  const notice = getPreExperimentReturnNotice('start-timeout-no-payment');

  assert.match(notice ?? '', /cannot rejoin this experiment session/i);
  assert.match(notice ?? '', /future recruitment/i);
  assert.equal(getPreExperimentReturnNotice('no-match'), notice);
  assert.equal(getPreExperimentReturnNotice('responsible'), null);
});

test('instruction navigation uses the standard English Back label', () => {
  const label = (
    terminationCopy as unknown as { INSTRUCTION_BACK_LABEL?: string }
  ).INSTRUCTION_BACK_LABEL;
  assert.equal(label, 'Back');
});

test('participant START is confirmed only after the server accepts it', async () => {
  const submit = (
    terminationCopy as unknown as {
      submitParticipantStart?: (
        fetcher: typeof fetch,
        serverUrl: string,
        identity: string,
      ) => Promise<void>;
    }
  ).submitParticipantStart;
  assert.equal(typeof submit, 'function');
  if (!submit) return;

  const calls: string[] = [];
  await submit((async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch, 'http://localhost:5173/', 'participant-a');

  assert.deepEqual(calls, ['http://localhost:5173/agent/participant-start']);
});

test('participant START reports a useful error when the experiment is not ready', async () => {
  const submit = (
    terminationCopy as unknown as {
      submitParticipantStart?: (
        fetcher: typeof fetch,
        serverUrl: string,
        identity: string,
      ) => Promise<void>;
    }
  ).submitParticipantStart;
  assert.equal(typeof submit, 'function');
  if (!submit) return;

  await assert.rejects(
    submit(
      (async () => new Response(
        JSON.stringify({ message: 'The experiment is not ready yet. Please wait and press START again.' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch,
      'http://localhost:5173',
      'participant-a',
    ),
    /not ready yet/i,
  );
});

test('participant START failure replaces the waiting prompt instead of creating an overlapping toast', () => {
  assert.equal(
    terminationCopy.getParticipantStartPrompt(
      2,
      false,
      'Could not confirm START. Please try again.',
    ),
    'Could not confirm START. Please try again.',
  );
});
