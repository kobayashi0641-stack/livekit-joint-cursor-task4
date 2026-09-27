#!/usr/bin/env tsx
/**
 * E2E test harness for all five experiment task types.
 *
 * For each task type, the harness:
 *   1. Resets the agent.
 *   2. POSTs a minimal rule sequence to /agent/rules — skips the
 *      wait/consent/11-instruction phases (handled separately by the
 *      browser admin tab) and runs N short trials only. For reaching
 *      it includes the avg-cursor-offset paradigm trial setup; for
 *      group it interleaves `computeGroups` rules between phases.
 *   3. Starts the agent and polls `/agent/status` until it reaches
 *      a terminal state (`completed` / `stopped` / `error`).
 *   4. Records the start/end time and any errors.
 *
 * Bots (run separately via `npm run simulate -- --count 3`) provide
 * cursor input. An admin browser tab opened on
 * `http://localhost:5173/?admin=<ADMIN_PASSWORD>&autoConnect=1` is required
 * for actual recording → Supabase upload — without it `recordingStatus`
 * never reaches `uploaded` and trials wait indefinitely. The harness
 * skips the wait by adding a sane timeout per task.
 */

const SERVER = process.env.SERVER ?? 'http://localhost:3001';
const ADMIN = process.env.ADMIN_PASSWORD;
if (!ADMIN) throw new Error('Missing required environment variable: ADMIN_PASSWORD');
const ROOM = process.env.ROOM ?? 'joint-cursor-task2';

const TRIAL_DURATION = 4; // seconds — short to keep total runtime sane
const TRIALS_PER_TASK = 2;
const REACHING_PRE = 1;
const REACHING_ROT = 2;
const REACHING_POST = 1;
const REACHING_ROT_DEG = 15;
const STATUS_POLL_MS = 1500;
const TASK_TIMEOUT_MS = 4 * 60_000; // 4 minutes — generous safety net

type Rule = Record<string, unknown>;

interface TaskCase {
  taskType:
    | 'circle-target-tracking'
    | 'guide-tracking'
    | 'non-guide-tracking'
    | 'group-circle-target-tracking'
    | 'reaching';
  buildRules(experimentName: string): Rule[];
}

function commonTrial(
  taskType: TaskCase['taskType'],
  experimentName: string,
  trialNumber: number,
  totalTrials: number,
  extras: Record<string, unknown> = {},
): Rule {
  return {
    type: 'executeTrial',
    trialNumber,
    totalTrials,
    durationSeconds: TRIAL_DURATION,
    taskType,
    experimentName,
    displayMode: 'avgOnly',
    ...extras,
  };
}

const CASES: TaskCase[] = [
  {
    taskType: 'circle-target-tracking',
    buildRules: (name) => [
      { type: 'setCursorVisibility', hideCursor: false },
      { type: 'setTaskMode', taskMode: 'circle-target-tracking' },
      ...Array.from({ length: TRIALS_PER_TASK }, (_, i) =>
        commonTrial('circle-target-tracking', name, i + 1, TRIALS_PER_TASK, {
          circleTargetPeriod: 5000,
          circleTargetRadius: 0.3,
        })),
      { type: 'endSession' },
    ],
  },
  {
    taskType: 'guide-tracking',
    buildRules: (name) => [
      { type: 'setCursorVisibility', hideCursor: false },
      { type: 'setTaskMode', taskMode: 'guide-tracking' },
      ...Array.from({ length: TRIALS_PER_TASK }, (_, i) =>
        commonTrial('guide-tracking', name, i + 1, TRIALS_PER_TASK, {
          circleTargetPeriod: 5000,
          circleTargetRadius: 0.3,
        })),
      { type: 'endSession' },
    ],
  },
  {
    taskType: 'non-guide-tracking',
    buildRules: (name) => [
      { type: 'setCursorVisibility', hideCursor: false },
      { type: 'setTaskMode', taskMode: 'manual-instruction' },
      ...Array.from({ length: TRIALS_PER_TASK }, (_, i) =>
        commonTrial('non-guide-tracking', name, i + 1, TRIALS_PER_TASK)),
      { type: 'endSession' },
    ],
  },
  {
    taskType: 'group-circle-target-tracking',
    buildRules: (name) => {
      const trials: Rule[] = [
        { type: 'setCursorVisibility', hideCursor: false },
        { type: 'setTaskMode', taskMode: 'circle-target-tracking' },
      ];
      // Two phases: split → merge. Each phase has TRIALS_PER_TASK trials.
      // computeGroups runs server-side and broadcasts setGroupAssignments.
      let tn = 0;
      const total = TRIALS_PER_TASK * 2;
      // Phase 1: split into 2 groups
      trials.push({ type: 'computeGroups', groupCount: 2 });
      for (let i = 0; i < TRIALS_PER_TASK; i++) {
        tn++;
        trials.push(commonTrial('group-circle-target-tracking', name, tn, total, {
          circleTargetPeriod: 5000,
          circleTargetRadius: 0.3,
        }));
      }
      // Phase 2: merge to single group
      trials.push({ type: 'computeGroups', groupCount: 1 });
      for (let i = 0; i < TRIALS_PER_TASK; i++) {
        tn++;
        trials.push(commonTrial('group-circle-target-tracking', name, tn, total, {
          circleTargetPeriod: 5000,
          circleTargetRadius: 0.3,
        }));
      }
      trials.push({ type: 'endSession' });
      return trials;
    },
  },
  {
    taskType: 'reaching',
    buildRules: (name) => {
      const trials: Rule[] = [
        { type: 'setCursorVisibility', hideCursor: false },
        { type: 'setTaskMode', taskMode: 'reaching' },
      ];
      const total = REACHING_PRE + REACHING_ROT + REACHING_POST;
      let tn = 0;
      for (let i = 0; i < REACHING_PRE; i++) {
        tn++;
        trials.push(commonTrial('reaching', name, tn, total, {
          cursorRotationDeg: 0,
        }));
      }
      for (let i = 0; i < REACHING_ROT; i++) {
        tn++;
        trials.push(commonTrial('reaching', name, tn, total, {
          cursorRotationDeg: REACHING_ROT_DEG,
        }));
      }
      for (let i = 0; i < REACHING_POST; i++) {
        tn++;
        trials.push(commonTrial('reaching', name, tn, total, {
          cursorRotationDeg: 0,
        }));
      }
      trials.push({ type: 'endSession' });
      return trials;
    },
  },
];

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, data };
}

async function getStatus() {
  const res = await fetch(`${SERVER}/agent/status?adminPassword=${encodeURIComponent(ADMIN)}`);
  if (!res.ok) throw new Error(`status fetch failed: ${res.status}`);
  return (await res.json()) as {
    status: 'idle' | 'running' | 'completed' | 'error' | 'stopped';
    currentStepIndex: number;
    rules: Rule[];
    participantCount: number;
    recordingStatus: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCase(c: TaskCase): Promise<{ taskType: string; experimentName: string; status: string; durationS: number; error?: string }> {
  const experimentName = `${c.taskType}__e2e-${Date.now()}`;
  const rules = c.buildRules(experimentName);

  console.log(`\n=== ${c.taskType} ===`);
  console.log(`experimentName: ${experimentName}`);
  console.log(`rules: ${rules.length}`);

  const t0 = Date.now();
  let lastError: string | undefined;

  // Always reset before starting so prior state doesn't bleed in.
  await postJson('/agent/reset', { adminPassword: ADMIN });
  const r = await postJson('/agent/rules', { adminPassword: ADMIN, rules });
  if (!r.ok) {
    return { taskType: c.taskType, experimentName, status: 'rules-failed', durationS: 0, error: JSON.stringify(r.data) };
  }
  const s = await postJson('/agent/start', { adminPassword: ADMIN, roomName: ROOM });
  if (!s.ok) {
    return { taskType: c.taskType, experimentName, status: 'start-failed', durationS: 0, error: JSON.stringify(s.data) };
  }

  // Poll until terminal state or timeout.
  let last = 'running';
  let lastStep = -1;
  while (Date.now() - t0 < TASK_TIMEOUT_MS) {
    await sleep(STATUS_POLL_MS);
    try {
      const st = await getStatus();
      if (st.currentStepIndex !== lastStep) {
        lastStep = st.currentStepIndex;
        const ruleType = (st.rules[st.currentStepIndex] as { type?: string } | undefined)?.type ?? '-';
        console.log(`  step ${st.currentStepIndex}/${st.rules.length - 1} (${ruleType})  status=${st.status}  rec=${st.recordingStatus}`);
      }
      last = st.status;
      if (st.status === 'completed' || st.status === 'error' || st.status === 'stopped' || st.status === 'idle' && lastStep >= 0) {
        // 'idle' after lastStep ≥ 0 happens when endSession resets the agent — treat as completed.
        break;
      }
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  const durationS = (Date.now() - t0) / 1000;
  console.log(`  done in ${durationS.toFixed(1)}s — status=${last}${lastError ? `, error=${lastError}` : ''}`);
  return { taskType: c.taskType, experimentName, status: last, durationS, error: lastError };
}

async function main() {
  console.log(`Test harness — server=${SERVER}, room=${ROOM}`);
  console.log(`Cases: ${CASES.map((c) => c.taskType).join(', ')}\n`);

  // Verify the agent endpoint is reachable.
  try {
    const st = await getStatus();
    console.log(`Initial agent state: status=${st.status}, participants=${st.participantCount}`);
  } catch (e) {
    console.error('Cannot reach agent. Is the server running on', SERVER, '?', (e as Error).message);
    process.exit(1);
  }

  const results: Array<Awaited<ReturnType<typeof runCase>>> = [];
  for (const c of CASES) {
    const r = await runCase(c);
    results.push(r);
    // Brief gap so the next task starts cleanly.
    await sleep(2000);
  }

  console.log(`\n=== Summary ===`);
  for (const r of results) {
    console.log(`  ${r.taskType.padEnd(32)} ${r.status.padEnd(10)} ${r.durationS.toFixed(1)}s  ${r.experimentName}`);
  }

  // Emit the recording names so the validation step can pick them up.
  const summaryPath = '/tmp/test-all-experiments.json';
  await import('node:fs').then((fs) => fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2)));
  console.log(`\nSummary saved to ${summaryPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
