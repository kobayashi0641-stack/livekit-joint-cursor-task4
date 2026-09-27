import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

test('server experiment timestamp formatter exists for Japan time', async () => {
  assert.equal(existsSync(new URL('./time.ts', import.meta.url)), true);
  const { formatTimestampForFilename } = await import('./time.js');
  assert.equal(
    formatTimestampForFilename(Date.parse('2025-12-31T15:30:00.000Z')),
    '2026-01-01T00-30-00',
  );
});
