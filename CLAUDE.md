# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time cursor-sharing experiment platform built on LiveKit (WebRTC SFU). Participants share cursor positions in a shared room while an admin controls display modes, tasks, and experiment flow. Used for behavioral research (e.g., Prolific crowdsourcing). Supports **config-based automated experiment orchestration** via the `ExperimentAgent`, session recording to Supabase, and replay.

## Commands

```bash
# Development (run server + web in separate terminals)
npm run dev:server          # Express server on :3001 (tsx watch, auto-reload)
npm run dev:web             # Vite dev server on :5173

# Local Supabase (optional, for recording)
npm run dev:docker          # Start PostgreSQL + PostgREST + Kong
npm run dev:docker:stop     # Stop containers
npm run dev:docker:reset    # Stop + delete volumes

# Build & check
npm run build               # Build web package only (Vite)
npm run typecheck            # TypeScript check across all workspaces

# Load testing
npm run simulate            # Headless bot participants via @livekit/rtc-node (default 5)
npm run simulate:browser    # Open browser tabs as participants (default 3)

# Debug-only helpers (not part of the public workflow; useful for verifying agent flow)
npx tsx scripts/debug-listener.ts          # Logs all control/target/broadcast messages
npx tsx scripts/debug-monitor.ts           # Computes raw + displayed avg from cursor topic
npx tsx scripts/debug-fake-admin.ts        # Plays admin role: ack recording-status + post raw avg
TRIALS=3 ROTATION_DEG=15 npx tsx scripts/debug-trigger.ts   # Skip wait/instructions, run N reaching trials

# End-to-end harness (needs dev:server + dev:web + simulate already running,
# plus an admin browser tab on /?admin=<ADMIN_PASSWORD> so recordings can upload)
npx tsx scripts/test-all-experiments.ts    # Run all 5 tasks back-to-back with minimal rule sets
npx tsx scripts/validate-recordings.ts     # Pull recordings from local Supabase and assert per-task invariants
```

No test or lint commands are configured. There is no shared type package — types are duplicated between server and web.

## URL Routing

All routing is via query params on the same origin:

| URL | Role | Description |
|-----|------|-------------|
| `/?admin=<ADMIN_PASSWORD>` | **Admin (main)** | LiveKit room connection, cursor stage, control panels, recording. **Must be open for agent recording to work.** |
| `/?admin=agent` | **Agent settings** | Experiment config UI, agent start/stop. Separate from main admin. |
| `/?admin=database` | **Database admin** | Recording browser, replay, download, delete. |
| `/?admin=viewer` | **Viewer** | Read-only cursor display (projector). |
| `/?device=mobile` | **Mobile** | Joystick controller UI. |
| `/` | **Participant** | Consent screen → cursor stage. |
| `/?PROLIFIC_PID=xxx` | **Participant** | Sets identity from Prolific. |
| `/?sim` | **Simulation** | Auto-connected with dummy cursors. |

## Architecture

**Monorepo** using npm workspaces (`packages/server`, `packages/web`).

### `packages/server` — Token Server + Experiment Agent

```
packages/server/src/
├── config.ts                 — env var loading (dotenv)
├── index.ts                  — Express app: /token, /kick, /agent/* endpoints
├── agent.ts                  — ExperimentAgent class (rule executors, recording, polling)
├── agent-rules.ts            — Rule type definitions + describeRule (no flow logic)
└── experiments/              ★ Per-task experiment scripts live here
    ├── index.ts              — Registry + generateRulesFromConfig
    ├── types.ts              — ExperimentTask, TrialContext interfaces
    ├── common-flow.ts        — Wait phase + 11 common instructions + final instructions
    ├── circle-target-tracking/
    │   ├── index.ts          — Exports the ExperimentTask
    │   ├── instructions.ts   — Task-specific instruction texts
    │   └── experiment.ts     — runTrialBody (target visibility + position publishing)
    ├── guide-tracking/       — Same 3-file structure
    ├── non-guide-tracking/   — Same 3-file structure
    ├── group-circle-target-tracking/  — Same 3-file structure + custom generateTrialSequence
    └── reaching/             — Same 3-file structure (visuomotor rotation paradigm)
```

- **`src/config.ts`** — Env var loading via dotenv. Required: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` (or `LIVEKIT_URL`), `ADMIN_PASSWORD`. Optional: `PORT` (default 3001), `TOKEN_TTL_SECONDS` (default 600).

- **`src/index.ts`** — Express app. Endpoints:
  - `GET /healthz` — Liveness probe (Render health check).
  - `GET /latency-threshold` — Public read of `config.latencyThresholdMs`; the participant consent screen fetches it to gate on median RTT.
  - `GET /token` — Issues LiveKit JWT. Admin detected via `adminPassword` query param.
  - `POST /kick` — Removes a participant from the room (admin-auth required).
  - **Agent API** (all admin-auth):
    - `GET /agent/status` — Agent state (status, currentStep, rules, config, recordingStatus).
    - `GET /agent/rules`, `POST /agent/rules` — Direct rule CRUD (legacy).
    - `GET /agent/config`, `POST /agent/config` — Experiment config get/set. Setting config auto-generates rules via `experiments/index.ts`'s `generateRulesFromConfig()`.
    - `POST /agent/start`, `POST /agent/stop`, `POST /agent/reset` — Agent lifecycle.
    - `POST /agent/area-report` — Cursor area reports from participants (Yes/No detection).
    - `POST /agent/virtual-cursor-report` — Pointer lock status reports.
    - `POST /agent/recording-status` — Recording/upload status from admin client. Used by agent to wait for upload completion between trials.
    - `POST /agent/avg-cursor` — Raw avg cursor position posted by admin at 10Hz during reaching trials. Agent applies its own `_avgCursorOffset` for reach detection.
    - `POST /agent/sketch-event` — Sketch-driven trial events from the admin client (e.g. reaching's `'reach'` hit). No auth (write-only); the agent's `waitForSketchEvent(name)` consumes them. See "Sketch-Driven Layer" below.
  - In production, serves the built web app as static files from `packages/web/dist`.

- **`src/agent-rules.ts`** — Rule type definitions only:
  - **`ExperimentConfig`** type — Task type, trial count, trial duration, wait time, min participants, instruction duration, circle target params, **plus reaching-specific fields**: `reachingTargetX/Y` (default 0.5/0.2), `reachingStartX/Y` (default 0.5/0.8), `reachingThreshold` (default 0.05), `reachingPreTrials/RotationTrials/PostTrials` (default 5/10/5), `reachingRotationDeg` (default 15). Also: **`trialDisplayMode`** (default `'avgOnly'`) — display mode applied during trial execution; can be overridden per-trial via `ExecuteTrialRule.displayMode`. **`latencyThresholdMs`** (default 100) — median LiveKit RTT cutoff on the participant consent screen (`GET /latency-threshold` exposes it publicly).
  - **`ExperimentTaskType`** — `'circle-target-tracking' | 'guide-tracking' | 'non-guide-tracking' | 'group-circle-target-tracking' | 'reaching'`.
  - **`TaskMode`** — `'target-tracking' | 'manual-instruction' | 'circle-target-tracking' | 'guide-tracking' | 'random-target-tracking' | 'reaching'`.
  - **`DEFAULT_EXPERIMENT_CONFIG`** — Default config values.
  - **16 rule types**: `waitForParticipants`, `showInstruction`, `setDisplayMode`, `setTaskMode`, `showYesNoAreas`, `hideYesNoAreas`, `wait`, `setCursorVisibility`, `enableVirtualCursor`, `resetVirtualCursorPosition`, `setClickAreaOverlay`, `startRecording`, `stopRecordingAndUpload`, `executeTrial`, `computeGroups`, `endSession`.
  - **`ExecuteTrialRule`** carries optional per-trial overrides: `circleTargetPeriod`, `circleTargetRadius`, **`cursorRotationDeg`** (visuomotor rotation in degrees, used by reaching's `generateTrialSequence` to vary rotation per phase), and **`displayMode`** (per-trial stage display mode; falls back to `config.trialDisplayMode`).
  - **`describeRule()`** — English human-readable description of each rule (rotation angle is shown for `executeTrial` when non-zero).
  - **No flow logic** — see `experiments/` instead.

- **`src/experiments/`** — **The central place for experiment flow definitions.** Each task type has its own directory with separated instruction texts and trial body code.
  - **`index.ts`** — `taskRegistry`, `getTask(type)`, `allTasks`, and **`generateRulesFromConfig(config)`** which builds the full rule sequence by combining `common-flow` fragments with the registered task's `generateInstructions` + `runTrialBody`.
  - **`types.ts`** — `ExperimentTask` (the contract each task module exports) and `TrialContext` (helpers the agent passes into `runTrialBody`).
    - `ExperimentTask` fields: `type`, `label`, `liveKitTaskMode`, `generateInstructions`, `runTrialBody`, optional `generateTrialSequence`, optional **`getInitialCursorPosition(config)`** (returns initial avg-cursor display position; presence triggers the offset paradigm in the framework).
    - `TrialContext` helpers: `broadcastTop`, **`broadcastBottom`** (persistent instruction at the stage bottom), `setTargetVisibility`, `setGuideRunning`, `publishCircleTarget`, **`setCursorRotation(degrees)`** (visuomotor rotation), **`setVirtualCursorPosition(x, y)`** (teleport every participant's virtual cursor), **`applyAvgCursorOffset(initialX, initialY)`** (calibrate avg-cursor display offset — see "Avg-cursor offset paradigm" below), **`publishStaticTarget(x, y, shape, color?)`** (single static target, optional CSS fill color), **`waitForAvgCursorNear(x, y, threshold, timeoutMs)`** (poll the displayed avg cursor and resolve when within threshold), **`waitForAvgCursorFar(fromX, fromY, threshold, timeoutMs)`** (mirror — resolve when displayed avg moves farther than threshold from a point; used by reaching to detect early movement during the pre-go-signal yellow target phase), the **sketch-driven helpers** **`startSketchHitDetector(params?)`** / **`stopSketchHitDetector()`** / **`waitForSketchEvent(name, timeoutMs)`** (admin polls the active sketch's `hit.detect` predicate; first fire POSTs a sketch event the agent awaits) and **`startSketchTrajectory(params)`** / **`stopSketchTrajectory()`** / **`publishSketchTrajectory(params, durationMs)`** (admin runs the active sketch's `trajectory.compute` publish loop), and `sleep`. Plus a `cursorRotationDeg` field on `ctx` that mirrors the rule's per-trial rotation. See "Sketch-Driven Layer" below.
  - **`common-flow.ts`** — `generateWaitPhase`, `generateCommonInstructions` (11 steps), `generateFinalInstructions`, plus the `buildExecuteTrialRule` helper used by both default and custom trial sequences.
  - **`<task-id>/instructions.ts`** — `generateInstructions(config): string[]` — task-specific instruction texts shown before trials begin (4–5 entries, each followed by Yes/No confirmation).
  - **`<task-id>/experiment.ts`** — `runTrialBody(ctx)` — the variable middle of one trial. Owns hint sends and target/guide control. The agent wraps this with common pre/post (recording, display setup, "Start" message, post-trial cleanup).
  - **`<task-id>/index.ts`** — Aggregates the above into an `ExperimentTask` object. Optional `generateTrialSequence(config, experimentName)` overrides the default `N × executeTrial` loop — used by `group-circle-target-tracking` to interleave `computeGroups` rules between phases, and by `reaching` to vary `cursorRotationDeg` across baseline/rotation/washout phases.
  - **`group-circle-target-tracking/`** — Same circle-tracking trial body, but `generateTrialSequence` produces three phases of `computeGroups` + `executeTrial × N`: **split → reshuffle → merge** (phase 1: random 2 groups, phase 2: re-shuffle 2 groups, phase 3: merge to 1 group). `config.trialCount` is interpreted as trials per phase (default 5 → 15 total).
  - **`reaching/`** — Visuomotor rotation reaching paradigm. `generateTrialSequence` builds three phases of trials: **`reachingPreTrials` baseline (rot=0°)** → **`reachingRotationTrials` adaptation (rot=`reachingRotationDeg`)** → **`reachingPostTrials` washout (rot=0°)** (defaults: 5 + 10 + 5 = 20 trials). The trial body uses a **yellow→red GO-signal pattern**: it (a) applies the rotation, (b) re-calibrates the avg-cursor offset defensively, (c) publishes a **yellow** static circle target so participants wait, (d) watches for early motion of the *displayed* avg cursor during a random 300–800ms hold and sends a one-shot "don't move yet" warning if displacement exceeds 20px ≈ 0.037 stage units (the trial proceeds either way), (e) re-publishes the same target in **red** as the GO signal, then (f) starts the sketch hit detector and awaits the `'reach'` sketch event (the reaching sketch's `hit.detect` checks the displayed avg cursor against `reachingThreshold`). `getInitialCursorPosition` returns `(reachingStartX, reachingStartY)`, which makes the framework use the avg-cursor offset paradigm (see below).

- **`src/agent.ts`** — `ExperimentAgent` class. Key methods:
  - `setConfig(config)` / `getConfig()` — Config management. Setting config regenerates rules via `experiments/index.ts`.
  - `start()` / `stop()` / `reset()` — Lifecycle management with `AbortController`.
  - `reportArea()` / `reportVirtualCursor()` / `reportRecordingStatus()` / **`reportAvgCursor()`** / **`reportSketchEvent(name, data?)`** — External status reports stored in private fields (`areaReports`, `virtualCursorReports`, `_recordingStatus`, `_avgCursorReport`, `_sketchEventInbox`).
  - Internal state for reaching: `_avgCursorReport` (raw avg posted by admin), `_avgCursorOffset` (coordinate-frame offset shared with all clients). For sketch events: `_sketchEventInbox` (`Map<name, report>`, cleared on start/reset).
  - **Rule executors** — `execWaitForParticipants` (with countdown timer, alternating messages, target publishing), `execShowInstruction`, `execExecuteTrial` (composite: start message → setup → "Start" display → recording → **delegates trial body to `task.runTrialBody(ctx)`** → stop recording → upload wait → reset for next trial), etc.
  - **`execExecuteTrial`** branches on `task.getInitialCursorPosition`. When defined (reaching), step 2 / post-trial run `execResetVirtualCursorPosition` → `sleep(300ms)` → `applyAvgCursorOffset` (so participants' virtual cursors hit (0.5, 0.5) AND the displayed avg shifts to the task's initial position). When absent, only the legacy `execResetVirtualCursorPosition` runs.
  - **`buildTrialContext()`** — Constructs the `TrialContext` passed into the per-task `runTrialBody`. Wires every helper above (`broadcastTop`, `setTargetVisibility`, `setGuideRunning`, `publishCircleTarget`, `setCursorRotation`, `setVirtualCursorPosition`, `applyAvgCursorOffset`, `publishStaticTarget`, `waitForAvgCursorNear`, `waitForAvgCursorFar`, the sketch helpers `startSketchHitDetector` / `stopSketchHitDetector` / `waitForSketchEvent` / `startSketchTrajectory` / `stopSketchTrajectory` / `publishSketchTrajectory`, `sleep`) to the task module.
  - **Sketch-driven helpers** — `startSketchHitDetector`/`stopSketchHitDetector` and `startSketchTrajectory`/`stopSketchTrajectory` just broadcast the matching control message (the admin client runs the actual loop). `publishSketchTrajectory(params, durationMs)` = start → sleep → stop (in `finally`). `waitForSketchEvent(name, timeoutMs)` polls `_sketchEventInbox` for a matching entry, consuming it on receipt. Used by reaching (`'reach'`) and circle-target-tracking (trajectory).
  - **`publishCircleTargetForDuration()`** — Legacy: agent directly computes and publishes circle target positions on `TARGET_TOPIC` at 20Hz. Still exposed via `ctx.publishCircleTarget`, but circle-target-tracking now uses `ctx.publishSketchTrajectory` (admin-side) instead.
  - **`applyAvgCursorOffset(initialX, initialY)`** — Reads latest `_avgCursorReport` (admin's raw avg), computes `offset = rawAvg − (initialX, initialY)`, stores it in `_avgCursorOffset`, and broadcasts `setAvgCursorOffset` to every client. Waits up to 2s for a fresh report; falls back to zero offset on timeout.
  - **`waitForAvgCursorNear(x, y, threshold, timeoutMs, signal)`** — Polls `_avgCursorReport` at 20Hz; computes `displayed = rawAvg − _avgCursorOffset`; resolves when distance to (x, y) is below threshold. Used by reaching to detect target reach in *displayed* coordinates.
  - **`execStopRecordingAndUpload()`** — Sends stop command, then polls `_recordingStatus` until admin client reports 'uploaded'.
  - Agent statuses: `idle` → `running` → `completed`/`error`/`stopped`.

### `packages/web` — React + Vite Frontend (p5.js-based stage)

```
packages/web/src/
├── App.tsx              — ~7500 lines, the single mega-component
├── AgentAdmin.tsx       — Agent configuration UI (~856 lines)
├── main.tsx             — React entry point
├── styles.css           — All CSS
└── experiments/         ★ p5.js stage rendering layer
    ├── TaskStage.tsx    — React↔p5 bridge component; mounts a 60 fps canvas
    ├── base-sketch.ts   — Common base scene (cursors, averages, lines, yes-no)
    ├── registry.ts      — TaskMode/ExperimentTaskType → TaskSketch lookup
    ├── types.ts         — SketchScene, TaskSketch (+ style/inputs/defaults/hit/trajectory), P5Dot/Target/Guide/YesNo
    ├── shared/          — draw.ts (primitives) + yes-no.ts (instruction component)
    └── <task-id>/sketch.ts  — Per-task `drawTaskLayer` (one per ExperimentTaskType)
```

All stage visuals — participant cursors, group/single average cursors, avg-cursor connector lines, targets (triangle / square / circle), guide circle, Yes/No areas, replay boundary box — are rendered by p5.js inside `<TaskStage>`. The previous DOM-based stage has been fully retired; broadcast messages, click-area-lock overlay, and other UI overlays are still DOM and live *outside* the canvas. See [CURSOR_DESIGN.md](./CURSOR_DESIGN.md) for the rendering pipeline and visual-design conventions.

- **`src/App.tsx`** (~7500 lines, single file) — Contains everything:
  - **`App` component** — Main entry. URL query param routing (see URL Routing above).
  - **Connection flow**: Fetch token from server → `new Room()` → `room.connect()` → listen on data topics → send cursor positions at ~30Hz.
  - **Cursor sending**: Binary 11-byte protocol via `CURSOR_TOPIC` (unreliable). Throttled by `SEND_INTERVAL_MS` (33ms) + dead-band (0.005). Keep-alive every 200ms. Stale cursors removed after 250ms.
  - **State sync**: Admin sends `ControlMessage` on `control` topic. New participants send `hello`, admin replies with full `state` payload.
  - **ControlMessage types** (20+ types): `setMode`, `setHideCursor`, `setTargetVisibility`, `setUseVirtualCursor`, `complete`, `kick`, `setYesNoAreas`, `setClickAreaOverlay`, `unlockPointerLock`, `resetVirtualCursorPosition`, `setCursorSize`, `setTargetSize`, `setGuideTrackingRunning`, `setJoystickMultiplier`, `resetMobileCursorPosition`, `taskControl`, **`agentStartRecording`**, **`agentStopRecording`**, **`agentStartCircleTarget`**, **`agentStopCircleTarget`**, **`setGroupAssignments`** (group experiments), **`setVirtualCursorPosition`** (teleport virtual cursor to (x, y)), **`setCursorRotation`** (visuomotor rotation in degrees, applied to pointer-locked input deltas), **`setAvgCursorOffset`** (coordinate-frame shift for the displayed avg cursor — reaching only), **`startSketchTrajectory`** / **`stopSketchTrajectory`** (admin runs the active sketch's `trajectory.compute` publish loop), **`startSketchHitDetector`** / **`stopSketchHitDetector`** (admin polls the active sketch's `hit.detect` predicate).
  - **Agent control messages** (handled in `handleControlMessage`):
    - `agentStartRecording` — Admin client starts recording with specified experiment name & trial number. Notifies server via `POST /agent/recording-status`.
    - `agentStopRecording` — Admin client stops recording, uploads to Supabase, notifies server when done. Uses `stopRecordingRef` (ref pattern) to avoid stale closure bug.
    - `agentStartCircleTarget` / `agentStopCircleTarget` — Circle target animation control (legacy, agent now publishes directly).
    - `startSketchTrajectory` / `stopSketchTrajectory` — **Admin-only.** Admin looks up the active sketch's `trajectory.compute` and runs a publish loop on `TARGET_TOPIC` at the sketch's interval until stopped.
    - `startSketchHitDetector` / `stopSketchHitDetector` — **Admin-only.** Admin polls the active sketch's `hit.detect(ctx)`; the first true fire POSTs the sketch's `eventName` to `/agent/sketch-event` and stops polling.
  - **`handleTaskControlMessage`** — Accepts `taskControl` from server (agent) for admin too (not just participants). This allows the agent to set task modes on the admin client.
  - **Broadcast message positions**: `'center'` (large text, blue overlay, e.g. "Start"), `'top'` (small gray text, transparent, e.g. task hints), `'bottom'` (inside stage, anchored to bottom edge, dark overlay, e.g. instructions).
  - **Recording system**: Admin starts recording → `setInterval` at 60 FPS captures `FrameSnapshot`. On stop, uploads to Supabase in batches (100 frames/batch). `stopRecordingRef` pattern ensures the latest `stopRecording` callback is used even from stale room event listeners.
  - **Target tracking systems**:
    - `target-tracking`: Random triangle positions every 2s (admin or agent publishes)
    - `circle-target-tracking`: Circular orbit — **admin's sketch `trajectory.compute` publishes positions on TARGET_TOPIC at 20Hz** while the agent's `publishSketchTrajectory` window is open (legacy: agent published directly via `publishCircleTargetForDuration`).
    - `guide-tracking`: Circle guide controlled via `setGuideTrackingRunning` control message
    - `random-target-tracking`: Sum-of-sinusoids trajectory (Yang, Cowan & Haith, eLife 2021)
    - `reaching`: Static circle target at fixed position (yellow "wait" → red "go"). Trial ends when the admin's sketch `hit.detect` reports the *displayed* avg cursor within `reachingThreshold` (POSTed as a `'reach'` sketch event). Each trial may carry a visuomotor rotation (`cursorRotationDeg`) applied to participants' pointer-locked input deltas.
  - **`p5StageX` derived memos** (~line 5058–5186) — A small family of `useMemo` hooks (`p5StageCursors`, `p5StageAverages`, `p5StageLines`, `p5StageTarget`, `p5StageGuide`, `p5StageYesNo`) translates the current React state into the prop arrays consumed by `<TaskStage>`. `visibleCursors` (~line 5024) drives `p5StageCursors` and applies the per-displayMode visibility rules. ViewerMode and ReplayModal compute equivalent prop arrays inline (cursor sources, labels, and palette differ — e.g. ViewerMode uses `#3b82f6` for the single avg and always shows displayName labels).
  - **`ReplayModal`** — Loads frames from Supabase, renders with `requestAnimationFrame`, supports seek/speed (0.25x–4x). Uses `<TaskStage>` with `showBoundaryBox` for the dashed [0,1] reference rectangle.
  - **`DatabaseAdmin`** — Lists recordings from Supabase, supports download (JSON), delete, replay.
  - **`ViewerMode`** — Full-screen read-only cursor display (for projecting).
  - **`MobileController`** — Touch joystick that sends velocity-based cursor movement.
  - **Werewolf cursors**: Admin-generated fake participants with noisy circular orbits.
  - **Virtual cursor / Pointer lock**: Participants can use pointer lock mode. Admin/agent can toggle remotely.
  - **Yes/No areas**: Circular regions at random positions. Participants report cursor area to server at 1s intervals.
  - **Group experiments**: `groupAssignments` state (mirrored to `groupAssignmentsRef` for synchronous capture access) holds the agent-broadcast `{identity → groupId, groupCount}` mapping. Two derived computations:
    - **`averageCursor` useMemo** — for participants in a group, filters to same-group cursors only (own group's avg). Admin/Viewer/ungrouped participants see the global avg (legacy behavior).
    - **`groupAverages` useMemo** — `Map<groupId, {x, y}>`. Empty when `groupCount ≤ 1`. Used by both `captureFrame` (persists `groupAverages` per FrameSnapshot, plus per-cursor `groupId`) and admin/viewer rendering (one avg cursor per group, color-coded via `colorForGroup(gid)` from the `GROUP_COLORS` palette).
  - **Reaching task plumbing** (see "Avg-cursor offset paradigm" below for the why):
    - **`rawAverageCursor` useMemo** — the previous `averageCursor` formula (mean of participant + werewolf cursors, group-filtered if applicable). What admin posts to `/agent/avg-cursor`.
    - **`averageCursor` useMemo** — `rawAverageCursor − avgCursorOffset` (the *displayed* avg cursor). Renders everywhere the avg is shown.
    - **`avgCursorOffsetRef` / `avgCursorOffset` state** — fed by the `setAvgCursorOffset` control message. Reset to (0, 0) when `taskMode !== 'reaching'`.
    - **`cursorRotationRadRef`** — visuomotor rotation in radians, set by `setCursorRotation`. Applied to `(dxNorm, dyNorm)` deltas in `handlePointerEvent` only when `isPointerLocked` is true. Reset to 0 when `taskMode !== 'reaching'`.
    - **Admin avg-cursor reporter** — `useEffect` posts `rawAverageCursorRef.current` to `/agent/avg-cursor` at 10Hz while `taskMode === 'reaching'` (admin only).
    - **Reaching target rendering** — added to the participant/admin main render *and* `ViewerMode` (two render sites) and to `captureFrame`'s target-shape filter.

- **`src/AgentAdmin.tsx`** (~856 lines) — Config-based experiment setup UI:
  - Password-protected. Polls agent status every 2s.
  - **Experiment configuration form**: task type (circle-target-tracking / guide-tracking / non-guide-tracking / **group-circle-target-tracking** / **reaching**), trial count, trial duration, wait time, min participants, instruction duration, circle target params (period/radius shown for circle and group-circle), **reaching params** (baseline/rotation/washout trial counts, rotation degrees, target/start positions, threshold — shown only for reaching).
  - "Save Config" saves to server and auto-generates rules. "Start Agent" saves + starts.
  - Selecting a task type pre-fills the form from that sketch's `defaults` (`getSketchByExperimentTask(type)?.defaults`), so a sketch can own task-specific positions/thresholds/phase counts. The server still executes whatever the form ultimately posts.
  - Collapsible generated rules viewer with current step highlighting (reaching trials display `, rot N°` when non-zero).
  - Summary line variants per task: group (`N trials × 3 phases`), reaching (`pre + rotation (N°) + washout = total`), default.
  - Types are simplified (`Record<string, any>`) since rules come from server JSON.

- **`src/main.tsx`** — React entry point.
- **`src/styles.css`** (~1638 lines) — All CSS. Stage is 540x540px max, white with rounded corners. 3-panel admin layout with resizable panels.

### Data Transport (LiveKit Data Channels)

7 topics used for real-time messaging:

| Topic | Reliability | Direction | Purpose |
|-------|------------|-----------|---------|
| `cursor` | Unreliable | Participant → All | Cursor positions, ~30Hz, binary 11 bytes |
| `control` | Reliable | Admin/Server → All | Display mode, task mode, cursor visibility, recording control, etc. |
| `broadcast` | Reliable | Admin/Server → All | Instruction messages with duration/severity/position |
| `chat` | Reliable | Participant → Admin | Text messages from participants |
| `stats` | Reliable | Participant → Admin | RTT, pointer lock status (~2s) |
| `target` | Reliable | Admin/Server → All | Target positions (reaching: agent via `publishStaticTarget`; circle: admin's sketch trajectory) |
| `werewolf` | Unreliable | Admin → All | Fake cursor positions (~30Hz) |

### Experiment Agent Flow

The agent (`ExperimentAgent`) executes a generated rule sequence. The full flow:

1. **Wait phase**: Display mode `self`, task mode `target-tracking` (triangles). Agent publishes target positions + alternating instruction messages at bottom + countdown timer at center (starts when first participant joins). Proceeds when `minParticipants` reached or timeout from first join.

2. **Common instructions** (11 steps): Each shows instruction at bottom → Yes/No area appears → proceeds when any participant enters Yes area or 6s timeout → hides Yes/No. Instructions cover: greeting, cursor visibility, virtual cursor setup (click area overlay + pointer lock), showing other cursors, showing average cursor.

3. **Task-specific instructions**: Varies by task type (circle-target-tracking: 5 steps, guide-tracking: 5 steps, non-guide-tracking: 4 steps). Each with Yes/No confirmation.

4. **Trial execution** (`executeTrial` rule): For each trial:
   - Bottom message: "Task will start soon (trial N of M)"
   - Setup: display `avgOnly`, reset virtual cursor position, start recording
   - Center: "Start" (2s)
   - Top hint: task instruction (changes at mid-trial)
   - First half: task runs (circle target visible / guide visible / free motion)
   - Mid-trial: hide target/guide
   - Second half: participants continue from memory
   - Post-trial: "This trial is now complete", stop recording + Supabase upload, display `self`, reset position
   - Top hint: "Data is now uploading..."
   - **Wait for upload completion** (polls `/agent/recording-status`)
   - Next trial message

5. **Final instructions**: "All trials complete" → "Thank you" (display `all-without-avg`) → "Redirecting to reward page" → `endSession`

#### Group experiments (`group-circle-target-tracking`)

When the task is `group-circle-target-tracking`, the trial loop is replaced by:

```
computeGroups(2)  → executeTrial × N        # phase 1: initial random 2-way split
computeGroups(2)  → executeTrial × N        # phase 2: re-shuffle into new 2 groups
computeGroups(1)  → executeTrial × N        # phase 3: merge everyone into one group
```

`computeGroups` runs server-side: it lists current non-admin participants, Fisher–Yates shuffles them, round-robin assigns to N groups (sizes differ by ≤1), and broadcasts `setGroupAssignments` on the control topic. Each participant's web client filters the average cursor to their own group; the admin / viewer renders one avg cursor per group color-coded via `colorForGroup`. The recording (frames) embeds per-cursor `groupId` and per-frame `groupAverages`, plus the recording row stores the group snapshot at start time.

#### Reaching experiments (`reaching`)

Visuomotor rotation reaching paradigm. `generateTrialSequence` produces:

```
executeTrial(rot=0°)  × reachingPreTrials       # baseline
executeTrial(rot=N°)  × reachingRotationTrials  # adaptation (rotation applied)
executeTrial(rot=0°)  × reachingPostTrials      # washout
```

Defaults: 5 + 10 + 5 = 20 trials, N = 15°, target at (0.5, 0.2), start at (0.5, 0.8), threshold 0.05.

Each `executeTrial` here:

- **Step 2 (framework)**: `setDisplayMode('avgOnly')` → `execResetVirtualCursorPosition` (every participant's virtual cursor → (0.5, 0.5)) → 300ms sleep → `applyAvgCursorOffset(reachingStartX, reachingStartY)` (agent reads admin's just-reported raw avg ≈ (0.5, 0.5), broadcasts `offset = rawAvg − initial` so everyone's *displayed* avg appears at the start position) → start recording.
- **Trial body**: `setCursorRotation(rotationDeg)` → defensive `applyAvgCursorOffset` (re-absorbs any drift during the 2s "Start" countdown) → `publishStaticTarget(targetX, targetY, 'circle', yellow)` + `setTargetVisibility(true)` → random 300–800ms hold (with a `waitForAvgCursorFar` early-motion warning) → `publishStaticTarget(..., red)` GO signal → `startSketchHitDetector({ threshold })` + `waitForSketchEvent('reach')` (admin polls the reaching sketch's `hit.detect`, which compares *displayed* avg = rawAvg − offset against the target) → `stopSketchHitDetector()` → `setTargetVisibility(false)`.
- **Step 5 (post-trial)**: same reset + offset re-calibration as step 2, so the next trial / inter-trial interval also shows the displayed avg at the start position.

Reach detection requires a connected admin: the admin both posts `rawAverageCursor` to `/agent/avg-cursor` at 10Hz (for the offset paradigm) **and** runs the sketch hit-detector loop that POSTs the `'reach'` event. Without admin, no `'reach'` event → `waitForSketchEvent` times out → trials end via `trialDurationSeconds`.

##### Avg-cursor offset paradigm

For tasks that need the displayed avg cursor to appear at a non-natural location (e.g. reaching needs (0.5, 0.8) at trial start), the framework uses a **coordinate-frame shift** instead of teleporting individual cursors. Mechanics:

1. Agent reads the latest raw avg posted by admin: `rawAvg` ≈ wherever participants' cursors actually average to.
2. Agent computes `offset = rawAvg − initialPos` and broadcasts `setAvgCursorOffset(offset)` to every client.
3. Every client computes `displayedAvg = rawAvg − offset` for rendering and recording.
4. At calibration time `displayedAvg = initialPos` (by construction). Afterwards `displayedAvg` tracks `rawAvg` 1-to-1, so when participants move, the displayed avg moves the same direction/magnitude.
5. Reach detection happens in displayed coordinates too: the admin's sketch `hit.detect` receives the already-offset `averageCursor` (rawAvg − offset), so the threshold check is against the displayed target. (The agent's `waitForAvgCursorNear` helper, which also subtracts the offset, remains available but reaching now uses the sketch hit detector.)

The offset paradigm is opt-in via `ExperimentTask.getInitialCursorPosition`. When that method is undefined the framework uses the legacy reset-to-(0.5, 0.5) flow with `offset = (0, 0)` (no shift), and `displayedAvg = rawAvg`.

### Sketch-Driven Layer (hit / trajectory / style / inputs / defaults)

Trial-critical logic that used to live in the server agent has been pushed into the web sketch files (`web/src/experiments/<task-id>/sketch.ts`). The agent stays the **orchestrator** (it decides *when* via `start*`/`stop*`), while the sketch owns the *what* (geometry, motion equation, visuals). The **admin client** is the executor — it is the only guaranteed-present client and already computes the avg cursor each frame. All capabilities below are optional fields on `TaskSketch` (web `experiments/types.ts`); the matching server helpers live on `TrialContext` and are wired in `agent.ts` `buildTrialContext()`.

- **`hit` (hit detection).** Agent calls `ctx.startSketchHitDetector(params)` → control message → admin polls the sketch's `hit.detect(ctx)` every `intervalMs` (default 50ms). The first `true` fire POSTs the sketch's `eventName` (default `'hit'`) to `POST /agent/sketch-event`; the agent's `ctx.waitForSketchEvent(name, timeoutMs)` resolves on receipt, then `ctx.stopSketchHitDetector()`. The `detect` ctx carries `averageCursor` (displayed = raw − offset), `rawAverageCursor`, `target`, `groupAverages`, the agent-supplied `params`, and `elapsedMs`. Geometry is free-form (Euclidean / rectangle / polygon / time-conditional). **Reaching** uses `eventName: 'reach'`, `params: { threshold }`.
- **`trajectory` (target motion).** Agent calls `ctx.publishSketchTrajectory(params, durationMs)` (start → sleep → stop in `finally`) → control message → admin publishes each non-null `trajectory.compute(elapsedMs, params)` → `{x, y, shape?, color?}` on `TARGET_TOPIC` at `intervalMs`. **Circle-target-tracking** uses `params: { period, radius }` — the motion equation now lives in the sketch (swap to Lissajous / random walk without server edits).
- **`style`** — per-element colors / sizes / strokes (cursor, average, groupAverage, target, guide, lines, yesNo). Read by App.tsx's `p5StageXxx` memos in preference to legacy app-state defaults. Target color priority: server-sent `scene.target.color` (e.g. reaching yellow→red) > `style.target.fill` > legacy `#ef4444`.
- **`inputs.cursorGain`** — pointer-lock input multiplier applied in `App.tsx` `handlePointerEvent` (via `cursorGainRef`) before the visuomotor rotation matrix. Active only while pointer-locked.
- **`defaults`** — `Partial<ExperimentConfig>` used by AgentAdmin to pre-fill the form when the task type is selected. UI-only; the server executes whatever the form posts.

**Degradation:** no admin tab → no sketch events and no published trajectory (same profile as the avg-cursor offset paradigm). Reaching's `waitForSketchEvent` times out via `trialDurationSeconds`; circle's target simply never appears.

### Key File: Where to Change What

| What to change | Where to edit |
|----------------|---------------|
| **Per-task instruction texts** (the 4–5 sentences shown before trials begin) | `server/src/experiments/<task-id>/instructions.ts` |
| **Per-task trial behavior** (target/guide visibility, hint sends, custom timing) | `server/src/experiments/<task-id>/experiment.ts` → `runTrialBody()` |
| **Common 11 instructions / wait phase / final 3 instructions** | `server/src/experiments/common-flow.ts` |
| **Add a new experiment task** | (1) Create `server/src/experiments/<new-task>/{instructions,experiment,index}.ts` (2) add the type to `ExperimentTaskType` in `agent-rules.ts` (3) register it in `experiments/index.ts` taskRegistry (4) add a button + label in `web/src/AgentAdmin.tsx` (TASK_TYPE_LABELS + button list) (5) if the task has its own target shape/style, add a render block in `App.tsx` next to the existing `circle-target-tracking` / `random-target-tracking` blocks **and** to `ViewerMode`, plus update `captureFrame`'s target-shape filter |
| **Group experiment phasing** (e.g. number of phases, group counts per phase) | `server/src/experiments/group-circle-target-tracking/index.ts` → `generateTrialSequence` |
| **Group avg cursor colors** | `web/src/App.tsx` → `GROUP_COLORS` palette / `colorForGroup` helper |
| **Reaching trial phasing / rotation degrees** | `server/src/experiments/reaching/index.ts` → `generateTrialSequence` (sets per-trial `cursorRotationDeg`) |
| **Reaching task params** (target/start position, threshold, trial counts) | `server/src/agent-rules.ts` → `ExperimentConfig` (`reachingTargetX/Y`, `reachingStartX/Y`, `reachingThreshold`, etc.) + UI in `web/src/AgentAdmin.tsx` |
| **Avg-cursor offset paradigm enable** (any new task that needs a non-natural avg start position) | Define `getInitialCursorPosition(config)` on the `ExperimentTask`. The framework auto-switches to reset-cursors + apply-offset flow. |
| **Trial pre/post wrapping** (recording start/stop, "Start" message, display setup) | `server/src/agent.ts` → `execExecuteTrial()` |
| **Agent config defaults / shape** | `server/src/agent-rules.ts` → `DEFAULT_EXPERIMENT_CONFIG` and `ExperimentConfig` type |
| **New rule types** | `server/src/agent-rules.ts` (type + union + describeRule) → `server/src/agent.ts` (executor in `executeRule` switch) |
| **TrialContext helpers** (new capabilities exposed to tasks) | `server/src/experiments/types.ts` (interface) → `server/src/agent.ts` → `buildTrialContext()` (implementation) |
| **Per-task stage visuals** (the layer painted on top of cursors / averages) | `web/src/experiments/<task-id>/sketch.ts` → `drawTaskLayer(p, scene, coords)` |
| **Common stage visuals** (cursors, averages, connector lines, Yes/No areas, boundary box) | `web/src/experiments/base-sketch.ts` (always-on) + `web/src/experiments/shared/draw.ts` (primitives) |
| **Adding p5 props consumed by `<TaskStage>`** (new dot color, new shape, opacity etc.) | `web/src/experiments/types.ts` (extend `P5Dot`/`P5Target`/`SketchScene`) → `web/src/experiments/shared/draw.ts` (renderer) → call sites in `App.tsx` (`p5StageX` memos) and `ViewerMode` |
| **Cursor visibility rules per displayMode** | `web/src/App.tsx` → `visibleCursors` memo (~line 5024) and the equivalent inline logic in `ViewerMode` |
| **Broadcast message rendering** (position, style, size) | `web/src/App.tsx` → search `broadcastMessages.map` (2 locations: main stage + ViewerMode) |
| **Control message handling** | `web/src/App.tsx` → `handleControlMessage` callback |
| **Task mode handling for admin** | `web/src/App.tsx` → `handleTaskControlMessage` (accepts server messages for admin) |
| **Recording start/stop from agent** | `web/src/App.tsx` → `agentStartRecording` / `agentStopRecording` handlers in `handleControlMessage` |
| **Circle target trajectory (motion equation)** | `web/src/experiments/circle-target-tracking/sketch.ts` → `trajectory.compute` (admin publishes; server brackets via `ctx.publishSketchTrajectory`). Legacy fallback: `server/src/agent.ts` → `publishCircleTargetForDuration()` |
| **Trial-end hit geometry** (Euclidean / rectangle / polygon / temporal) | `web/src/experiments/<task-id>/sketch.ts` → `hit.detect` + `eventName`; server calls `ctx.startSketchHitDetector(params)` + `ctx.waitForSketchEvent(name)` |
| **Per-task visual style** (colors / sizes / strokes) | `web/src/experiments/<task-id>/sketch.ts` → `style` block (consumed by `p5StageXxx` memos in `App.tsx`) |
| **Per-task input gain** (pointer-lock cursor speed) | `web/src/experiments/<task-id>/sketch.ts` → `inputs.cursorGain` (applied in `App.tsx` `handlePointerEvent`) |
| **Per-task form defaults** (positions / thresholds / phase counts) | `web/src/experiments/<task-id>/sketch.ts` → `defaults` (pre-fills AgentAdmin form) |
| **Visuomotor rotation behavior** (input-delta rotation, applied client-side) | `web/src/App.tsx` → `handlePointerEvent` (rotation matrix on `dxNorm/dyNorm` when `isPointerLocked`) |
| **Bot simulator behavior under reaching/rotation** | `scripts/simulate-participants.ts` (handles `taskControl`, `setVirtualCursorPosition`, `resetVirtualCursorPosition`, `setTargetVisibility`, `setAvgCursorOffset`, `setCursorRotation`) |
| **API endpoints** | `server/src/index.ts` |
| **Agent admin UI** | `web/src/AgentAdmin.tsx` |
| **CSS / layout** | `web/src/styles.css` |
| **Database schema** | `supabase/init/01-schema.sql` and `packages/web/supabase_schema.sql` |

### Cursor Binary Encoding

11 bytes: version `uint8` (1) + identity hash `uint16` big-endian (2) + x `uint16` (2) + y `uint16` (2) + timestamp `uint32` (4). Coordinates mapped from [-4.0, 5.0] range to [0, 65535] to allow off-screen tracking. Identity hash: `(hash * 31 + charCode) & 0xffff`. The same encoding is reimplemented in `scripts/simulate-participants.ts`.

### Headless bot simulator (`scripts/simulate-participants.ts`)

Default behavior is the legacy circular orbit around (0.5, 0.5). To support reaching tests, bots additionally listen on the control + target topics and switch behavior:

- `taskControl` → toggles `mode = 'orbit' | 'reach'`. Leaving `'reaching'` resets target/offset state and resumes orbit.
- `resetVirtualCursorPosition` / `setVirtualCursorPosition` → teleport (mirrors the React app).
- `setTargetVisibility` → updates a flag.
- `setAvgCursorOffset` → stored so the bot drifts toward the *raw* target = displayed target + offset (otherwise the displayed avg never reaches the displayed target through coordinate-frame shift).
- `setCursorRotation` → applied to the bot's drift direction as a **naive simulated human** (no compensation), so cursor traces a curve when rotation is non-zero. Rotation 0 reduces to identity, leaving non-rotation phases unaffected.

This means `npm run simulate` is sufficient to validate the full reaching trial flow end-to-end (display avg starting position, rotation curving, trial advancement) without needing real browser participants.

### Debug helpers (`scripts/debug-*.ts`)

- **`debug-listener.ts`** — Joins as a non-publishing participant; logs every control / target / broadcast message it sees.
- **`debug-monitor.ts`** — Joins as a non-publishing participant; computes `raw` and `displayed` (after subtracting `setAvgCursorOffset` it observes) avg cursors at 2Hz and prints with the latest broadcast event for time-aligned debugging.
- **`debug-fake-admin.ts`** — Joins as admin; auto-acknowledges `agentStartRecording` / `agentStopRecording` to `/agent/recording-status` (so trials advance without a real admin uploading) and posts the running raw avg to `/agent/avg-cursor` at 10Hz.
- **`debug-trigger.ts`** — POSTs a minimal hand-crafted rule sequence to `/agent/rules` and `/agent/start`. `TRIALS=N` controls trial count, `ROTATION_DEG=θ` controls per-trial rotation. Skips wait + instruction phases entirely so reaching can be exercised in seconds.
- **`debug-participant.ts`** — Joins as a **publishing** participant that mirrors the browser's reaching plumbing: on `setVirtualCursorPosition` / `resetVirtualCursorPosition` it republishes its cursor at the new position and logs the running avg, so you can verify reset → publish → avg propagation. Env: `SERVER`, `ROOM`, `IDENTITY`.

### Database Schema (Supabase / PostgreSQL)

4 tables with cascade delete from `recordings`. Schema defined in both `supabase/init/01-schema.sql` (Docker init) and `packages/web/supabase_schema.sql` (manual setup):

- **`recordings`** — `id` UUID PK, `experiment_name`, `trial_number`, `room_name`, `start_time`/`end_time` (epoch ms), `frame_rate`, `total_frames`, **`group_assignments`** JSONB (identity→groupId at recording start), **`group_count`** INTEGER (1 = no grouping)
- **`frames`** — `recording_id` FK, `frame_number`, `timestamp`, `average_x/y`, `target_x/y/shape`, `cursors` JSONB array (each cursor includes optional `groupId`), **`group_averages`** JSONB (per-group avg, e.g. `{"0":{"x":..,"y":..}}`)
- **`events`** — `recording_id` FK, `event_type`, `event_data` JSONB, `timestamp`, `relative_time`
- **`broadcast_messages`** — `recording_id` FK, `message_id`, `text`, `duration_ms`, `severity`, `position`, `timestamp`

RLS enabled with open anon access (insert + select on all; update on recordings only).

Both schema files include `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements for the group columns, so a manual `psql` run of either file applies the migration on existing DBs without losing data.

### Infrastructure

- **LiveKit Cloud**: SaaS WebRTC SFU (cannot run locally, requires API key/secret)
- **Supabase**: PostgreSQL + PostgREST for recording storage. Optional locally via Docker (`docker-compose.yml` runs PostgreSQL:15 on port 54322, PostgREST, Kong on port 54321)
- **Render.com**: Production deployment. Single web service runs compiled server which serves static web build. See `render.yaml`.

## Environment Variables

Server (`packages/server/.env`): `LIVEKIT_API_KEY` (required), `LIVEKIT_API_SECRET` (required), `LIVEKIT_WS_URL` (required, fallback `LIVEKIT_URL`), `ADMIN_PASSWORD` (required), `PORT` (default 3001), `TOKEN_TTL_SECONDS` (default 600)

Web (`packages/web/.env.local`): `VITE_TOKEN_SERVER` (**required for dev** — set to `http://localhost:3001` to avoid requests going to Vite dev server), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_COMPLETION_URL`

See `.env.example` / `.env.local.example` in each package.

## Key Patterns & Conventions

- **Admin identity prefix**: `admin:` — checked in both server (`getParticipantCount` filters out admins) and client (control messages only accepted from `admin:` identities or server-sent)
- **URL-based routing**: No React Router. All routing via `?admin=`, `?device=`, `?sim`, `?dummy` query params parsed in `App()` component
- **State sync protocol**: New participants send `{type:'hello'}` → admin replies with full `{type:'state', payload:{...}}` containing all current settings
- **Agent sends data server-side**: `ExperimentAgent` uses `RoomServiceClient.sendData()` — it pushes messages into the room without being a connected participant. Client handles these as `participant === undefined`
- **Stale closure workaround**: Room event listener (`room.on(DataReceived, ...)`) is registered once at connect time and captures stale closures. Critical callbacks (e.g. `stopRecording`) use a **ref pattern** (`stopRecordingRef.current`) to always access the latest version.
- **Sketch-driven hit/trajectory**: The admin client (not the server) runs the per-frame loops — it polls the active sketch's `hit.detect` and runs the sketch's `trajectory.compute` publish loop, both gated by the agent's `start*`/`stop*` control messages. The sketch owns geometry/motion; the agent owns timing. Reaching POSTs `'reach'` to `/agent/sketch-event`; circle-target-tracking publishes its trajectory on `TARGET_TOPIC`. (Legacy `publishCircleTargetForDuration` on the agent still exists as a fallback.) Admin accepts target messages from server (participant === undefined) for recording.
- **Recording upload flow**: Agent sends `agentStopRecording` → admin calls `stopRecording()` → uploads to Supabase → POSTs to `/agent/recording-status` with `'uploaded'` → agent polls and proceeds.
- **Avg-cursor offset paradigm**: When a task defines `getInitialCursorPosition`, the agent broadcasts `setAvgCursorOffset` so every client computes `displayedAvg = rawAvg − offset`. Reach detection then runs on the displayed value — the admin's sketch `hit.detect` receives the offset `averageCursor` (the agent's own `waitForAvgCursorNear` helper, which also subtracts the offset, is the legacy path). Admin reports the **raw** avg to `/agent/avg-cursor`; never the displayed value (the agent owns the offset).
- **Visuomotor rotation**: Applied client-side in `handlePointerEvent` only when `isPointerLocked` is true (rotation matrix on input deltas). For ergonomics, both rotation and avg-cursor offset are auto-reset to zero when `taskMode !== 'reaching'` via a useEffect safety net. Agent re-issues `setCursorRotation` at every trial start (0 for baseline/washout) so values never leak across phases.
- **Three p5 stage sites in `App.tsx`**: the main participant/admin stage (~line 6642), `ViewerMode` (~line 1950), and `ReplayModal` (~line 832). Each builds its own `P5Dot[]`/`P5Target`/etc. inline because cursor sources, labels, and palette differ. Adding a new task or visual usually means updating the corresponding **`experiments/<task-id>/sketch.ts`** (the always-loaded base sketch already handles cursors/averages/Yes-No). For new target shapes you may also need to extend `captureFrame`'s target-shape filter at ~line 2280 so replays persist the right shape.
- **p5.js HSL strings require an integer hue**. p5.js 1.x's `color()` parser uses `INTEGER = /(\d{1,3})/` for the hue component of `hsl(H, S%, L%)`; a decimal hue silently falls through every CSS pattern and renders **white**. Any helper that produces a CSS color string handed to `p.fill()` (e.g. `colorFromIdentity` in `App.tsx`) must round the hue to an integer. Hex colors (`#1d4ed8`) and named colors are safe.
- **Prolific integration**: `endSession` rule redirects participants to Prolific completion URL. Kicked participants get a different completion code (`CCJ6W1JJ` vs `CFL5QARB`)
- **Type duplication**: `DisplayMode`, `TaskMode`, `ExperimentConfig`, `AgentState`, `ExperimentTaskType` are defined independently in both `server/src/agent-rules.ts` and `web/src/AgentAdmin.tsx`. Changes must be synced manually.
- **PostgREST schema cache**: `localhost:54321` (Kong → PostgREST) caches the DB schema at startup. After running `ALTER TABLE` on the local Docker DB, run `docker exec livekit-cursor_mesh-db-1 psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema';"` (or `docker restart livekit-cursor_mesh-rest-1`) — otherwise PostgREST returns `PGRST204 column does not exist` errors. Supabase Cloud auto-refreshes; this is a local-only concern.
