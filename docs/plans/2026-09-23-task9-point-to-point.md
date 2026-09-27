# Task9 Point-to-Point Scoring Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Replace Task9's moving-target tracking trial with a 30-second point-to-point game using 13 triangular-lattice target locations, continuous 50 ms dwell scoring, individual baseline/washout scores, an authoritative shared score, and persisted score history.

**Architecture:** Keep the server agent responsible for phase sequencing and trial duration. Put deterministic grid/target-selection/dwell rules in a pure web helper, render and detect hits in the Task9 p5 sketch, and route score events through `App.tsx`: solo events travel reliably from each participant to the admin, while shared hits are accepted and rebroadcast only by the admin. Persist acquisition events in the existing recording event stream and mirror current scores/targets into every frame.

**Tech Stack:** TypeScript, React, p5.js, LiveKit reliable data messages, Express experiment agent, Node's built-in test runner via `tsx`.

---

### Task 1: Pure triangular-grid and dwell-scoring rules

**Files:**
- Create: `packages/web/src/experiments/task9/point-to-point.ts`
- Create: `packages/web/src/experiments/task9/point-to-point.test.ts`

**Step 1: Write failing tests**

Cover these behaviors:

- `createTask9TargetGrid()` returns 13 unique in-bounds triangular-lattice vertices: center, six nearest neighbours, and six next-nearest neighbours.
- `selectNextTargetIndex(seed, sequence, previousIndex, identity)` is deterministic, never immediately repeats, and does not select the center for the initial target.
- `updateDwellState(state, inside, now, 50)` scores only after 50 continuous milliseconds and resets the dwell start when the cursor leaves.
- `getTask9Clock(elapsedMs, 3000, 30000)` yields countdown values 3, 2, 1, then a clamped remaining-trial time.

**Step 2: Run the test and verify RED**

Run: `npx tsx packages/web/src/experiments/task9/point-to-point.test.ts`

Expected: FAIL because `point-to-point.ts` does not exist.

**Step 3: Implement the pure helper**

Export stable types and functions for the 13-point grid, deterministic hashing/selection, dwell transitions, and countdown/trial clock. Keep all functions browser-safe and free of React/p5 dependencies.

**Step 4: Run the test and verify GREEN**

Run: `npx tsx packages/web/src/experiments/task9/point-to-point.test.ts`

Expected: all Task9 helper tests pass.

### Task 2: Server-side Task9 trial orchestration

**Files:**
- Modify: `packages/server/src/experiments/task9/index.ts`
- Modify: `packages/server/src/experiments/task9/experiment.ts`
- Modify: `packages/server/src/experiments/task9/instructions.ts`
- Modify: `packages/web/src/experiments/task9/sketch.ts`
- Test: `packages/server/src/task9-point-to-point.test.ts`

**Step 1: Write a failing server test**

Assert Task9 defaults and generated rules use only `baseline -> shared -> washout`, default to 30-second trials, retain `self` for solo phases and `avgOnly` for shared, and initialize every trial at `(0.5, 0.5)`.

**Step 2: Run the test and verify RED**

Run: `npx tsx packages/server/src/task9-point-to-point.test.ts`

Expected: FAIL because Task9 still runs moving-target tracking and exposes the old label/default duration.

**Step 3: Implement minimal server orchestration**

- Rename the Task9 label to `Point-to-Point Task`.
- Keep existing baseline/shared/washout phase counts; omit adaptation trials from Task9's sequence.
- Add `getInitialCursorPosition()` returning the center.
- In `runTrialBody`, enable the phase-appropriate cursor control, center cursors, set recording metadata, publish one Task9 game descriptor/initial target, show the target grid, wait for the 3-second countdown plus 30-second/configured duration, then hide/disable the task.
- Update participant instructions to describe targets, 50 ms continuous dwell, score, and the individual/shared phases.

**Step 4: Run the test and verify GREEN**

Run: `npx tsx packages/server/src/task9-point-to-point.test.ts`

Expected: pass.

### Task 3: Task9 p5 rendering and local hit detection

**Files:**
- Modify: `packages/web/src/experiments/task9/sketch.ts`
- Test: `packages/web/src/experiments/task9/point-to-point.test.ts`

**Step 1: Add failing state-machine tests**

Test trial-key reset, solo target selection by participant identity, no duplicate score event for one target sequence, and shared state remaining unchanged until an authoritative target update arrives.

**Step 2: Run the tests and verify RED**

Run: `npx tsx packages/web/src/experiments/task9/point-to-point.test.ts`

Expected: new state-machine tests fail.

**Step 3: Replace the Task9 sketch**

- Draw all 13 positions as gray circular outlines.
- Fill only the active location red.
- Use the participant cursor in baseline/washout and the shared cursor in shared trials.
- Require 50 ms continuous containment; leaving the target resets dwell immediately.
- Draw `Score: N` at top-left and the remaining `30` to `0` seconds at top-right.
- Draw large centered `3`, `2`, `1` during the pre-trial countdown.
- Dispatch a typed window event containing the phase, target, score timing, and next target request; never render historical scores.

**Step 4: Run the tests and verify GREEN**

Run: `npx tsx packages/web/src/experiments/task9/point-to-point.test.ts`

Expected: pass.

### Task 4: Reliable score synchronization and recording history

**Files:**
- Modify: `packages/web/src/App.tsx`
- Create: `packages/web/src/task9-score-events.ts`
- Create: `packages/web/src/task9-score-events.test.ts`

**Step 1: Write failing protocol/reducer tests**

Test that:

- solo hit events retain participant identity and update only that participant's score/target;
- shared hit events update the single `shared` score and reject stale duplicate sequence numbers;
- event records retain target presentation/acquisition timestamps, movement time, and continuous dwell time;
- frame-state snapshots expose current score and target per participant/shared trial.

**Step 2: Run the tests and verify RED**

Run: `npx tsx packages/web/src/task9-score-events.test.ts`

Expected: FAIL because the score protocol/reducer does not exist.

**Step 3: Implement score event routing**

- Add a reliable `task9Score` stats message.
- For baseline/washout, publish local initialization/hit state to the admin without broadcasting it to the other participant.
- For shared trials, let only the admin accept a hit, choose the next deterministic target, update its own state, and publish the authoritative target/score through reliable `TARGET_TOPIC` data.
- Ignore duplicate/stale hit reports using `(trialKey, identity/shared, sequence)`.
- Reset all Task9 score refs when a new trial key starts.

**Step 4: Persist history and frame state**

- Extend `AdminEvent` with a `task9Score` acquisition event containing trial, phase, identity/shared scope, score, target index/position, presented/acquired timestamps, movement time, and dwell duration.
- Extend `FrameSnapshot` with current Task9 score and target-index maps.
- Populate those fields inside `captureFrame`; existing generic recording event storage will upload the detailed history without a database migration.

**Step 5: Run the tests and verify GREEN**

Run: `npx tsx packages/web/src/task9-score-events.test.ts`

Expected: pass.

### Task 5: Admin defaults, copy, and end-to-end verification

**Files:**
- Modify: `packages/web/src/AgentAdmin.tsx`
- Modify: `packages/web/src/experiments/task9/sketch.ts`
- Modify: `packages/server/src/experiments/task9/instructions.ts`

**Step 1: Update Task9-facing defaults/copy**

- Set Task9 default duration to 30 seconds.
- Show a Task9 summary describing 13 targets, 50 ms dwell, and baseline/shared/washout scoring.
- Keep target images unchanged for now.

**Step 2: Run focused tests**

Run:

```powershell
npx tsx packages/web/src/experiments/task9/point-to-point.test.ts
npx tsx packages/web/src/task9-score-events.test.ts
npx tsx packages/server/src/task9-point-to-point.test.ts
```

Expected: all pass.

**Step 3: Run repository verification**

Run:

```powershell
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0. Inspect the Task9 diff to verify no Task1/Task8 behavior changed.
