import assert from 'node:assert/strict';
import test from 'node:test';

import * as contribution from './shared-contribution.js';

test('consent data collection items appear in the requested order', () => {
  const copy = contribution as unknown as {
    CONSENT_DATA_COLLECTION_ITEMS?: readonly string[];
  };

  assert.deepEqual(copy.CONSENT_DATA_COLLECTION_ITEMS, [
    'Your Prolific ID',
    'Your cursor position data during the session',
    'Your questionnaire responses',
  ]);
});

test('consent copy explains the question after every shared-cursor trial', () => {
  const copy = contribution as unknown as {
    SHARED_CONTRIBUTION_CONSENT_COPY?: string;
  };

  assert.equal(
    copy.SHARED_CONTRIBUTION_CONSENT_COPY,
    'After each shared-cursor trial, rate your contribution to controlling the cursor.',
  );
});

test('shared contribution questionnaire runs from 7 to 1 with the requested anchors', () => {
  const copy = contribution as unknown as {
    SHARED_CONTRIBUTION_QUESTION?: string;
    SHARED_CONTRIBUTION_OPTIONS?: ReadonlyArray<{ value: number; label?: string }>;
    SHARED_CONTRIBUTION_SUBMIT_LABEL?: string;
    isSharedContributionSelected?: (value: unknown) => boolean;
  };

  assert.equal(
    copy.SHARED_CONTRIBUTION_QUESTION,
    'Rate your contribution to moving the shared cursor.',
  );
  assert.deepEqual(copy.SHARED_CONTRIBUTION_OPTIONS, [
    { value: 7, label: 'I did' },
    { value: 6 },
    { value: 5 },
    { value: 4, label: 'Equal contribution' },
    { value: 3 },
    { value: 2 },
    { value: 1, label: 'My partner did' },
  ]);
  assert.equal(copy.SHARED_CONTRIBUTION_SUBMIT_LABEL, 'OK');
  assert.equal(copy.isSharedContributionSelected?.(null), false);
  assert.equal(copy.isSharedContributionSelected?.(undefined), false);
  for (const option of copy.SHARED_CONTRIBUTION_OPTIONS ?? []) {
    assert.equal(copy.isSharedContributionSelected?.(option.value), true);
  }
  assert.equal(copy.isSharedContributionSelected?.(8), false);
  assert.equal(copy.isSharedContributionSelected?.(9), false);
});

test('shared contribution choices have distinct controls and generous click targets', () => {
  const ui = contribution as unknown as {
    SHARED_CONTRIBUTION_PANEL_MAX_WIDTH_PX?: number;
    SHARED_CONTRIBUTION_OPTION_MIN_HEIGHT_PX?: number;
    SHARED_CONTRIBUTION_OPTION_GAP_PX?: number;
    getSharedContributionInputId?: (value: number) => string;
  };
  const ids = contribution.SHARED_CONTRIBUTION_OPTIONS.map((option) => (
    ui.getSharedContributionInputId?.(option.value)
  ));

  assert.equal(typeof ui.getSharedContributionInputId, 'function');
  assert.equal(new Set(ids).size, contribution.SHARED_CONTRIBUTION_OPTIONS.length);
  assert.ok((ui.SHARED_CONTRIBUTION_PANEL_MAX_WIDTH_PX ?? 0) >= 520);
  assert.ok((ui.SHARED_CONTRIBUTION_OPTION_MIN_HEIGHT_PX ?? 0) >= 96);
  assert.ok((ui.SHARED_CONTRIBUTION_OPTION_GAP_PX ?? 0) >= 8);
});

test('Task9 asks participants to rate their contribution to earning the points', () => {
  const getQuestion = (
    contribution as unknown as {
      getSharedContributionQuestion?: (taskType: string | null) => string;
    }
  ).getSharedContributionQuestion;

  assert.equal(typeof getQuestion, 'function');
  if (!getQuestion) return;
  assert.equal(getQuestion('task9'), 'Rate your contribution to earning the points');
  assert.equal(getQuestion('cursor-control-20260706'), contribution.SHARED_CONTRIBUTION_QUESTION);
  assert.equal(getQuestion(null), contribution.SHARED_CONTRIBUTION_QUESTION);
});

test('shared contribution is published to the admin recording before the agent is notified', async () => {
  const deliver = (
    contribution as unknown as {
      deliverSharedContributionResponse?: (
        publishToAdmin: () => Promise<void>,
        notifyAgent: () => Promise<void>,
      ) => Promise<void>;
    }
  ).deliverSharedContributionResponse;

  assert.equal(typeof deliver, 'function');
  if (!deliver) return;

  const order: string[] = [];
  await deliver(
    async () => { order.push('admin recording'); },
    async () => { order.push('agent acknowledgement'); },
  );

  assert.deepEqual(order, ['admin recording', 'agent acknowledgement']);
});
