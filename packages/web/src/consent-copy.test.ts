import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('consent page shows participant requirement and unpaid waiting notice as separate items', () => {
  assert.match(
    appSource,
    /This experiment will begin once\s*<strong>TWO<\/strong>\s*participants have joined\. There are no scheduled breaks during this study\.\s*<\/li>/,
  );
  assert.match(
    appSource,
    /<li>\s*Please be aware that you may need to wait up to 5 minutes for the other participant to join, and this waiting time is\s*<strong>NOT INCLUDED<\/strong>\s*in the compensation\.\s*<\/li>/,
  );
  assert.doesNotMatch(appSource, /\(You may need to wait for the other participant to join\.\)/);
});
