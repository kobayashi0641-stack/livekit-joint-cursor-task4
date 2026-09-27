import assert from 'node:assert/strict';
import test from 'node:test';

test('the inter-trial upload notice includes the completed trial number', async () => {
  let messageModule: typeof import('./inter-trial-message') | null = null;
  try {
    messageModule = await import('./inter-trial-message');
  } catch {
    // RED: the formatter does not exist yet.
  }
  assert.ok(messageModule, 'inter-trial message formatter must exist');
  assert.equal(
    messageModule.formatInterTrialUploadMessage(3, 15),
    'Trial 3 of 15 is complete.\nData is now uploading...',
  );
});
