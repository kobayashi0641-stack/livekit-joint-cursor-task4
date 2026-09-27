import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const expectedRoom = 'joint-cursor-task4';

function read(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

test('Task4 runtime entry points use an isolated Task4 room by default', () => {
  const runtimeSources = [
    './index.ts',
    './agent.ts',
    '../../web/src/App.tsx',
    '../../web/src/AgentAdmin.tsx',
  ];

  for (const source of runtimeSources) {
    const contents = read(source);
    assert.match(contents, new RegExp(expectedRoom), `${source} must default to ${expectedRoom}`);
    assert.doesNotMatch(contents, /joint-cursor-task2/, `${source} still references the Task2 room`);
  }
});
