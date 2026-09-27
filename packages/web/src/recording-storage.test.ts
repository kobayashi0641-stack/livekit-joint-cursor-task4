import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRecordingStorage } from './recording-storage.js';

test('local development identifies the Docker-backed Supabase destination', () => {
  assert.deepEqual(
    describeRecordingStorage(false, 'http://127.0.0.1:54321'),
    {
      mode: 'local',
      label: 'Local Supabase (Docker)',
      url: 'http://127.0.0.1:54321',
      detail: 'Stored in the local Docker PostgreSQL volume on this PC.',
    },
  );
});

test('production identifies the remote Supabase destination', () => {
  assert.deepEqual(
    describeRecordingStorage(true, 'https://example.supabase.co/'),
    {
      mode: 'remote',
      label: 'Remote Supabase',
      url: 'https://example.supabase.co',
      detail: 'Stored in the configured remote Supabase project.',
    },
  );
});
