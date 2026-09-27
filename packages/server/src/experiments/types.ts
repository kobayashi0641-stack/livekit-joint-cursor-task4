/**
 * Type contracts shared by all experiment task modules.
 *
 * Each task lives in its own directory under `experiments/<task-id>/` and
 * exports an {@link ExperimentTask} that the agent registry picks up.
 */

import type {
  AgentRule,
  ExperimentConfig,
  ExperimentTaskType,
  TaskMode,
} from '../agent-rules.js';

/**
 * Helpers exposed to a task's `runTrialBody`. The agent owns the implementations;
 * tasks only call into this surface so they remain decoupled from LiveKit details.
 */
export interface TrialContext {
  config: ExperimentConfig;
  trialNumber: number;
  totalTrials: number;
  /** Full trial duration in seconds (as configured). */
  durationSeconds: number;
  /** Half of the trial duration in milliseconds (used for first/second halves). */
  halfDurationMs: number;
  /** Visuomotor rotation (degrees) for this trial, if specified by the rule. */
  cursorRotationDeg?: number;
  /** Phase label for tasks with custom multi-phase trial sequences. */
  sharedPhase?: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
  /** Visual gain used by Task 7 adaptation trials. */
  sharedVisualGain?: number;
  /** Task 7 visual disturbance schedule for this trial. */
  sharedDisturbance?: Record<string, unknown>;
  signal: AbortSignal;

  /** Broadcast a small hint message at the top of the stage. */
  broadcastTop(text: string, durationMs: number): Promise<void>;
  /** Broadcast a persistent instruction at the bottom of the stage. */
  broadcastBottom(text: string, durationMs: number): Promise<void>;
  /** Show or hide the tracking target. */
  setTargetVisibility(visible: boolean): Promise<void>;
  /**
   * Start or stop the arc guide animation.
   * @param radius Optional radius (0–0.5 in stage units) to broadcast
   *   alongside the running flag. When provided, all clients update their
   *   local `circleTargetRadius` state so the guide is drawn at the
   *   experiment-config radius (set via AgentAdmin). Without this,
   *   clients would render the guide with their stale default radius.
   *   Pass `config.circleTargetRadius` from `runTrialBody` to keep the
   *   rendered guide in sync with the AgentAdmin form.
   */
  setGuideRunning(running: boolean, radius?: number): Promise<void>;
  /**
   * Publish circle target positions on TARGET_TOPIC at 20 Hz for the given duration.
   * `period` is one revolution in ms; `radius` is in 0–0.5 stage units.
   */
  publishCircleTarget(period: number, radius: number, durationMs: number): Promise<void>;
  /**
   * Apply a visuomotor rotation (in degrees) to participants' cursor input.
   * Each frame, the input delta is rotated by this angle before being applied
   * to the virtual cursor position. Use 0 to remove rotation.
   */
  setCursorRotation(degrees: number): Promise<void>;
  /**
   * Set the virtual cursor position (in stage units 0–1) for all participants.
   * Teleports each participant's cursor to (x, y). Available as a primitive,
   * but reaching does *not* use this — see `applyAvgCursorOffset` instead.
   */
  setVirtualCursorPosition(x: number, y: number): Promise<void>;
  setUseVirtualCursor(enabled: boolean): Promise<void>;
  setClickAreaOverlay(show: boolean): Promise<void>;
  unlockPointerLock(): Promise<void>;
  /**
   * Calibrate the avg-cursor coordinate frame so the displayed avg cursor
   * appears at `(initialX, initialY)` right now. Reads the latest raw avg
   * cursor (reported by the admin client at 10Hz) and broadcasts an offset
   * to every client so `displayed = rawAvg - offset = initial` at this moment
   * and tracks rawAvg movement afterwards. Participants' cursors themselves
   * are *not* touched.
   */
  applyAvgCursorOffset(initialX: number, initialY: number): Promise<void>;
  /**
   * Publish a single static target position on TARGET_TOPIC. Optional `color`
   * is forwarded to clients and rendered as the target fill (any CSS color
   * string). When omitted, clients fall back to the task-mode default color.
   * Used by tasks that have a fixed target (e.g. reaching).
   */
  publishStaticTarget(
    x: number,
    y: number,
    shape: 'circle' | 'square' | 'triangle',
    color?: string,
  ): Promise<void>;
  /**
   * Wait until the latest reported avg cursor position is within `threshold`
   * (Euclidean distance, stage units) of the given point, or until `timeoutMs`
   * elapses. Returns whether the target was reached.
   */
  waitForAvgCursorNear(
    x: number,
    y: number,
    threshold: number,
    timeoutMs: number,
  ): Promise<{ reached: boolean }>;
  /**
   * Wait until the displayed avg cursor moves *farther than* `threshold` from
   * `(fromX, fromY)`, or until `timeoutMs` elapses. Used by reaching to detect
   * early movement during the pre-go-signal "yellow target" phase. Returns
   * `{ moved: true }` on motion detected, `{ moved: false }` on timeout.
   */
  waitForAvgCursorFar(
    fromX: number,
    fromY: number,
    threshold: number,
    timeoutMs: number,
  ): Promise<{ moved: boolean }>;

  // ── Sketch-driven hit detection ─────────────────────────────────────
  /**
   * Send `startSketchHitDetector` control message. The admin client begins
   * polling the active sketch's `hit.detect(ctx)` predicate at the
   * sketch's configured interval. The first true firing POSTs a
   * sketchEvent which {@link waitForSketchEvent} consumes.
   *
   * The sketch is the single source of truth for hit geometry — the agent
   * doesn't know whether the predicate is Euclidean, rectangular, polygon,
   * or time-conditional.
   */
  startSketchHitDetector(params?: Record<string, unknown>): Promise<void>;
  /** Stop the admin client's hit polling loop. */
  stopSketchHitDetector(): Promise<void>;
  /**
   * Wait until an admin POSTs a sketch event with the given `name`, or
   * until `timeoutMs` elapses. Pair with {@link startSketchHitDetector}
   * (or any other admin-initiated sketch event). Returns `fired: true`
   * with optional data on receipt, `fired: false` on timeout.
   */
  waitForSketchEvent(
    name: string,
    timeoutMs: number,
  ): Promise<{ fired: boolean; data?: unknown }>;

  // ── Sketch-driven trajectory ────────────────────────────────────────
  /**
   * Send `startSketchTrajectory(params)` control message. The admin
   * client looks up the active sketch's `trajectory.compute` function
   * and starts a publish loop at the sketch's configured interval. Each
   * non-null compute result is published on TARGET_TOPIC.
   *
   * Use this when the motion equation should live in the sketch (e.g.
   * researchers want to customize circle radius, period, or even switch
   * to a Lissajous figure or random walk without server changes).
   */
  startSketchTrajectory(params: Record<string, unknown>): Promise<void>;
  /** Stop the admin client's trajectory publish loop. */
  stopSketchTrajectory(): Promise<void>;
  /**
   * Convenience: start trajectory → sleep `durationMs` → stop. Stop is
   * called via `finally` so AbortSignal triggers still clean up the
   * admin's publish loop.
   */
  publishSketchTrajectory(
    params: Record<string, unknown>,
    durationMs: number,
  ): Promise<void>;
  publishInitialTargetWithTrajectory(params: Record<string, unknown>): Promise<void>;
  /** Persist per-trial parameters alongside the active recording. */
  setRecordingMetadata(metadata: Record<string, unknown>): Promise<void>;
  waitForSharedTrackingCompletions(
    trialKey: string,
    requiredCount: number,
    timeoutMs: number,
  ): Promise<{ completed: number }>;
  setSharedCursorControl(params: {
    enabled: boolean;
    phase?: 'baseline' | 'adaptation' | 'shared' | 'solo' | 'washout';
    matrix?: number[];
    visualGain?: number;
    disturbance?: Record<string, unknown>;
  }): Promise<void>;
  showSharedCursorQuestionnaire(
    trialNumber: number,
    kind?: 'legacy' | 'contribution',
  ): Promise<void>;
  hideSharedCursorQuestionnaire(): Promise<void>;
  waitForSharedCursorResponses(
    trialNumber: number,
    requiredCount: number,
    timeoutMs: number,
  ): Promise<{ completed: number }>;
  /** Sleep, respecting the abort signal. */
  sleep(ms: number): Promise<void>;
}

export interface ExperimentTask {
  /** Identifier matching `ExperimentTaskType`. */
  type: ExperimentTaskType;
  /** Human-readable label. */
  label: string;
  /** LiveKit task mode applied immediately before trial execution starts. */
  liveKitTaskMode: TaskMode;
  /**
   * Task-specific instructions shown (with Yes/No confirmation between each)
   * after the common 11 instructions, before trials begin.
   */
  generateInstructions(config: ExperimentConfig): string[];
  /**
   * Body of one trial. The agent wraps this with common pre/post steps
   * (display setup, recording start/stop, "Start" message, post-trial cleanup),
   * so this function only contains the variable middle portion.
   */
  runTrialBody(ctx: TrialContext): Promise<void>;
  /**
   * Optional: produce the trial-loop rule sequence (the rules between
   * `setTaskMode` and the final instructions). If omitted, a default loop of
   * `config.trialCount` × `executeTrial` rules is generated.
   *
   * Use this for tasks that need to interleave other rules between trials
   * (e.g. `computeGroups` for group-based experiments).
   */
  generateTrialSequence?(config: ExperimentConfig, experimentName: string): AgentRule[];
  /**
   * Optional: position the virtual cursor should be placed at when each trial
   * starts (during the framework's setup phase) and at the end of post-trial
   * cleanup (so the cursor stays there between trials too). Defaults to
   * (0.5, 0.5) when not provided. Reaching uses this to keep the cursor at the
   * trial start location throughout the "Start" countdown and inter-trial
   * messages.
   */
  getInitialCursorPosition?(config: ExperimentConfig): { x: number; y: number };
}
