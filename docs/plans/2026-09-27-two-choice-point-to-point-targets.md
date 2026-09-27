# Two-Choice Point-to-Point Targets Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Show two red Task4 point-to-point targets at once, always equidistant from the last acquired grid point, and branch from whichever target is reached.

**Architecture:** Extend the Task9 trial state from one active target index to a pair plus a previous/acquired anchor index. Generate a deterministic pair by uniformly choosing a valid distance shell and then two distinct points within that shell. Solo phases advance locally from each participant's acquired point; Shared advances only through the admin's authoritative shared-cursor event.

**Tech Stack:** TypeScript, React, p5.js, LiveKit data messages, Node test runner via `tsx`.

---

### Task 1: Deterministic equidistant pair generation

**Files:**
- Modify: `packages/web/src/experiments/task9/point-to-point.ts`
- Test: `packages/web/src/experiments/task9/point-to-point.test.ts`

1. Add failing tests that every anchor and many seeds produce two distinct non-anchor grid points at equal distance, with deterministic output and more than one distance shell across seeds.
2. Run `npx tsx packages/web/src/experiments/task9/point-to-point.test.ts` and confirm the missing pair generator fails.
3. Add a distance-shell builder using rounded squared lattice distances and a seeded `selectNextTargetPair(seed, sequence, previousIndex)` selector.
4. Re-run the focused test and confirm it passes.

### Task 2: Pair-aware scoring and branching

**Files:**
- Modify: `packages/web/src/experiments/task9/point-to-point.ts`
- Test: `packages/web/src/experiments/task9/point-to-point.test.ts`

1. Add failing tests for initial center-anchored pairs, arrival at either offered target, disappearance of the unchosen target, next-pair anchoring at the acquired point, dwell reset when switching candidates, and Shared authoritative advancement.
2. Change `Task9TrialState` to store `previousTargetIndex`, `targetIndices`, and target-specific dwell state.
3. Keep `targetIndex` in acquisition records as the acquired target; add offered, unchosen, and next-pair fields.
4. Update Shared parameter validation so only a matching sequence and offered pair can advance authoritative state.
5. Re-run focused tests.

### Task 3: Render two targets and synchronize Shared state

**Files:**
- Modify: `packages/web/src/experiments/task9/sketch.ts`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/src/experiments/task9/point-to-point.test.ts`

1. Add a failing sketch test asserting all 19 outlines remain and exactly two targets are red while only the occupied target becomes green.
2. Render both active indices, detect which active target contains the relevant solo/shared cursor, and dispatch pair-aware score events.
3. Update App's Shared admin handler and recorded admin event to broadcast/store the authoritative pair fields.
4. Verify the focused web test.

### Task 4: Recording metadata and full verification

**Files:**
- Modify only if required: `packages/server/src/experiments/task9/experiment.ts`
- Test: existing Task9 server and web tests

1. Confirm the existing point-to-point metadata identifies the 19-point grid and the new acquisition event contains pair details; avoid unrelated schema changes.
2. Run focused Task9 server/web tests.
3. Run `npm run typecheck` and `npm run build`.
4. Run `git diff --check` and inspect the final diff for unrelated changes.

