#!/usr/bin/env tsx
/**
 * Debug-only agent trigger.
 *
 * Posts a minimal reaching rule set (1 trial only) to the agent and starts
 * it. Used together with debug-listener.ts to verify the message flow
 * (setVirtualCursorPosition, target topic, etc.).
 */

const SERVER = process.env.SERVER ?? 'http://localhost:3001';
const ADMIN = process.env.ADMIN_PASSWORD;
if (!ADMIN) throw new Error('Missing required environment variable: ADMIN_PASSWORD');

const TRIALS = parseInt(process.env.TRIALS ?? '3', 10);
const ROTATION_DEG = parseFloat(process.env.ROTATION_DEG ?? '0');
const rules = [
  { type: 'setTaskMode', taskMode: 'reaching' },
  ...Array.from({ length: TRIALS }, (_, i) => ({
    type: 'executeTrial',
    trialNumber: i + 1,
    totalTrials: TRIALS,
    durationSeconds: 8,
    taskType: 'reaching',
    experimentName: 'debug-reaching',
    cursorRotationDeg: ROTATION_DEG,
  })),
];

async function post(path: string, body: unknown) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, data };
}

async function main() {
  console.log('[trigger] Resetting agent…');
  console.log(await post('/agent/reset', { adminPassword: ADMIN }));

  console.log('[trigger] Setting custom rules…');
  console.log(await post('/agent/rules', { adminPassword: ADMIN, rules }));

  console.log('[trigger] Starting agent…');
  console.log(await post('/agent/start', { adminPassword: ADMIN, roomName: 'joint-cursor-task2' }));
  console.log('[trigger] Done. Watch the listener log.');
}

main().catch((err) => {
  console.error('[trigger] Fatal:', err);
  process.exit(1);
});
