import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const agentSource = readFileSync(new URL('../../server/src/agent.ts', import.meta.url), 'utf8');
const task1ExperimentSource = readFileSync(
  new URL('../../server/src/experiments/cursor-control-20260706/experiment.ts', import.meta.url),
  'utf8',
);
const serverSource = readFileSync(new URL('../../server/src/index.ts', import.meta.url), 'utf8');

test('recording rows use the immutable finalized session identity', () => {
  assert.match(appSource, /experiment_name:\s*finalSession\.experimentName\.trim\(\)/);
  assert.match(appSource, /trial_number:\s*finalSession\.trialNumber/);
  assert.doesNotMatch(appSource, /experiment_name:\s*experimentName\.trim\(\)/);
  assert.doesNotMatch(appSource, /trial_number:\s*trialNumber,/);
});

test('recordings are uploaded through a sequential retry queue', () => {
  assert.match(appSource, /SequentialUploadQueue/);
  assert.match(appSource, /maxAttempts:\s*[3-9]/);
  assert.match(appSource, /recordingUploadQueueRef\.current\.enqueue/);
});

test('recording status reports identify the exact experiment and trial', () => {
  assert.match(appSource, /postRecordingStatusWithRetry/);
  assert.match(appSource, /experimentName:\s*stoppedRecording\.experimentName/);
  assert.match(appSource, /trialNumber:\s*stoppedRecording\.trialNumber/);
  assert.match(serverSource, /const \{ status, experimentName, trialNumber \} = req\.body/);
  assert.match(agentSource, /recordingUploadKey\(experimentName, trialNumber\)/);
});

test('participants continuously see the upload message between trials without waiting for upload', () => {
  assert.doesNotMatch(agentSource, /The next trial will begin shortly\.\.\./);
  assert.match(agentSource, /formatInterTrialUploadMessage\(trialNumber, totalTrials\)/);
  assert.match(
    task1ExperimentSource,
    /broadcastBottom\('', 1\);[\s\S]{0,200}setTargetVisibility\(true\)/,
  );
  assert.doesNotMatch(agentSource, /Promise\.all\([\s\S]{0,300}execStopRecordingAndUpload/);
});

test('participant completion is sent before the admin waits for background uploads', () => {
  const endSessionSource = agentSource.slice(agentSource.indexOf('private async execEndSession'));
  const completionSend = endSessionSource.indexOf("type: 'complete' as const");
  const finalFlush = endSessionSource.indexOf('waitForRecordingUploadsAfterCompletion');
  assert.ok(completionSend >= 0);
  assert.ok(finalFlush > completionSend);
});

test('embedded recording database refreshes after each completed upload', () => {
  assert.match(appSource, /const \[recordingDatabaseRefreshKey, setRecordingDatabaseRefreshKey\] = useState\(0\)/);
  assert.match(appSource, /setRecordingDatabaseRefreshKey\(\(key\) => key \+ 1\)/);
  assert.match(appSource, /<DatabaseAdmin embedded refreshKey=\{recordingDatabaseRefreshKey\} \/>/);
  assert.doesNotMatch(appSource, /<DatabaseAdmin embedded refreshKey=\{trialNumber\} \/>/);
});
