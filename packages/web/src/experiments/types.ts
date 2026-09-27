import type p5 from 'p5';

/**
 * Coordinate-space mapping. Element x/y are interpreted within
 * `[minX, minX + rangeX] × [minY, minY + rangeY]` and projected onto the
 * canvas. The default identity viewport `[0,1] × [0,1]` matches the live
 * experiment stage; the replay overrides this to fit recorded trajectory
 * bounds.
 */
export type Viewport = { minX: number; minY: number; rangeX: number; rangeY: number };

export const DEFAULT_VIEWPORT: Viewport = { minX: 0, minY: 0, rangeX: 1, rangeY: 1 };

/** A single circular element (cursor, average cursor, werewolf …). */
export type P5Dot = {
  id: string;
  x: number;
  y: number;
  diameter: number;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  label?: {
    text: string;
    color?: string;
    extra?: string;
    extraColor?: string;
  };
};

export type P5Target = {
  x: number;
  y: number;
  shape: 'triangle' | 'circle' | 'square';
  /** Pixel size (diameter for circle, side for square, base width for triangle). */
  size: number;
  fill: string;
  /** Optional live trajectory metadata for sketches that can animate locally. */
  trajectoryParams?: TrajectoryParams;
  trajectoryElapsedMs?: number;
  trajectoryReceivedAt?: number;
};

/**
 * A hollow circle drawn at (cx, cy) with normalized half-radius. The
 * rendered ellipse uses canvas width / height directly so a non-square
 * stage produces an ellipse — matching the original CSS-percentage box.
 */
export type P5Guide = {
  cx: number;
  cy: number;
  radius: number;
  stroke: string;
  strokeWidth: number;
};

export type P5YesNo = {
  yesPosition: { x: number; y: number };
  noPosition: { x: number; y: number };
  size: number;
};

export type P5Line = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  dashed?: boolean;
};

/** Scalars that map viewport coords → canvas pixels for the current frame. */
export type CoordMap = {
  sx: (x: number) => number;
  sy: (y: number) => number;
  W: number;
  H: number;
};

/**
 * The TaskMode values the client distinguishes for rendering. Duplicated
 * here so experiment sketches don't have to import from App.tsx.
 */
export type TaskMode =
  | 'target-tracking'
  | 'manual-instruction'
  | 'circle-target-tracking'
  | 'guide-tracking'
  | 'random-target-tracking'
  | 'reaching'
  | 'shared-single-cursor';

/**
 * The five experiment-task identifiers, mirroring
 * `packages/server/src/experiments/<task-id>/`.
 */
export type ExperimentTaskType =
  | 'circle-target-tracking'
  | 'guide-tracking'
  | 'non-guide-tracking'
  | 'group-circle-target-tracking'
  | 'reaching'
  | 'shared-single-cursor-control'
  | 'cursor-control-20260706'
  | 'task8'
  | 'task9';

/**
 * DisplayMode mirrored from server/src/agent-rules.ts. Duplicated here so
 * the web sketch types can reference it without a server import (server is
 * Node, web is browser — no shared build target). Keep this in sync with
 * the server definition; AgentAdmin.tsx also keeps a copy.
 */
export type DisplayMode =
  | 'all-without-avg'
  | 'all-with-avg-lines'
  | 'all-with-avg-no-lines'
  | 'avgOnly'
  | 'self'
  | 'self-with-avg';

/**
 * Experiment configuration sent from the AgentAdmin form to the server
 * agent (`POST /agent/config`). Mirrors `ExperimentConfig` in
 * `server/src/agent-rules.ts`. Keep field names + types in sync with the
 * server definition — AgentAdmin posts this verbatim as JSON.
 *
 * A sketch can declare its own task-specific defaults for any subset of
 * these fields via {@link TaskSketch.defaults}; AgentAdmin loads those
 * values into the form when the researcher selects that task type.
 */
export interface ExperimentConfig {
  taskType: ExperimentTaskType;
  trialCount: number;
  trialDurationSeconds: number;
  waitTimeMinutes: number;
  minParticipants: number;
  instructionDurationMs: number;
  experimentName: string;
  circleTargetPeriod: number;
  circleTargetRadius: number;
  reachingTargetX: number;
  reachingTargetY: number;
  reachingStartX: number;
  reachingStartY: number;
  reachingThreshold: number;
  reachingPreTrials: number;
  reachingRotationTrials: number;
  reachingPostTrials: number;
  reachingRotationDeg: number;
  sharedPracticeTrials: number;
  sharedMainTrials: number;
  sharedSoloTrials: number;
  sharedWait1MinSeconds: number;
  sharedWait1MaxSeconds: number;
  sharedWait2Seconds: number;
  sharedMatrix: [number, number, number, number, number, number, number, number];
  sharedTargetAmplitudes: [number, number, number];
  sharedTargetOmegaX: [number, number, number];
  sharedTargetOmegaY: [number, number, number];
  sharedTargetPhaseX: [number, number, number];
  sharedTargetPhaseY: [number, number, number];
  sharedRandomizePhasesPerTrial: boolean;
  sharedPhaseSeed: number;
  cursorControlBaselineTrials: number;
  cursorControlAdaptationTrials: number;
  cursorControlSharedTrials: number;
  cursorControlWashoutTrials: number;
  cursorControlAdaptationStartGain: number;
  cursorControlAdaptationEndGain: number;
  cursorControlGainTargetA1: number;
  cursorControlGainTargetB1: number;
  cursorControlGainTargetA2: number;
  cursorControlGainTargetB2: number;
  cursorControlGainStepPerTrial: number;
  cursorControlRotationTargetDeg1: number;
  cursorControlRotationTargetDeg2: number;
  cursorControlRotationStepDegPerTrial: number;
  cursorControlRampStartSeconds: number;
  cursorControlRampDurationSeconds: number;
  trialDisplayMode: DisplayMode;
  latencyThresholdMs: number;
}

/**
 * The complete scene description handed to sketches every frame. The
 * `base-sketch` consumes everything except `target` / `guide` (those are
 * task-specific and owned by per-task sketches).
 */
export interface SketchScene {
  viewport: Viewport;
  background?: string;
  showBoundaryBox?: boolean;
  taskMode?: TaskMode | null;
  cursors: P5Dot[];
  averages: P5Dot[];
  lines: P5Line[];
  target: P5Target | null;
  guide: P5Guide | null;
  yesNo: P5YesNo | null;
}

/**
 * Visual parameter declaration for a single experiment task.
 *
 * Each per-task sketch can declare the diameters, colors, sizes and stroke
 * properties of every visual element used by that task. When set, these
 * values feed the `p5StageXxx` memos in `App.tsx`, taking precedence over
 * the legacy app-state defaults (`participantCursorSize`, etc.) for cases
 * where the researcher wants the experiment-task file to be the single
 * source of truth.
 *
 * Every field is **optional**. Unspecified fields fall back to the previous
 * behavior (React state value or hardcoded default), so existing sketches
 * keep working without any style block. The control message protocol is
 * unchanged — the server agent still owns *when* and *which shape* of
 * target appears (e.g. reaching's yellow→red transition), while the sketch
 * owns the visual style of those elements.
 *
 * Use this when you want to write a new experiment and have the
 * `experiments/<task-id>/sketch.ts` file fully describe the visual look
 * (colors, sizes, stroke widths) without touching App.tsx.
 */
export interface TaskSketchStyle {
  /** Participant cursor visual style. */
  cursor?: {
    /** Pixel diameter. Default: app-state `participantCursorSize` (18). */
    diameter?: number;
    /** Fill color (CSS string). Default: participant identity color. */
    fill?: string;
    /** 0–1 opacity. Default: 1. */
    opacity?: number;
  };
  /** Single (non-grouped) average cursor visual style. */
  average?: {
    /** Pixel diameter. Default: app-state `averageCursorSize` (22). */
    diameter?: number;
    /** Fill color (CSS string). Default: `'#1d4ed8'`. */
    fill?: string;
  };
  /** Group average cursor visual style (only used when group_count > 1). */
  groupAverage?: {
    /** Pixel diameter. Default: app-state `averageCursorSize` (22). */
    diameter?: number;
    /**
     * Optional color palette indexed by groupId. Falls back to
     * `GROUP_COLORS` in App.tsx when undefined.
     */
    colorPalette?: string[];
  };
  /** Target visual style. */
  target?: {
    /**
     * Optional shape override. When undefined, the shape from the agent's
     * `target` topic message (or the task-mode default) is used. This lets
     * a sketch force a specific shape regardless of server hints.
     */
    shape?: 'triangle' | 'circle' | 'square';
    /** Pixel size. Default: task-mode-dependent. */
    size?: number;
    /**
     * Fill color (CSS string). The priority chain for the final color is:
     *   1. `scene.target.color` (server-sent, e.g. reaching yellow→red)
     *   2. this `fill` field
     *   3. legacy default `'#ef4444'`
     */
    fill?: string;
  };
  /** Guide circle visual style (Guide Tracking task). */
  guide?: {
    /** Stroke color. Default: `'#8b0000'`. */
    stroke?: string;
    /** Stroke width in px. Default: 4. */
    strokeWidth?: number;
    /**
     * Optional radius override (0–0.5 in stage units). When undefined the
     * value comes from app state (`circleTargetRadius`), which is mutated
     * by the admin UI / server agent. Setting this pins the radius to a
     * sketch-controlled constant.
     */
    radius?: number;
  };
  /** Cursor↔average connector lines (only in `all-with-avg-lines` mode). */
  lines?: {
    /** Line color override. When undefined, each line uses its cursor's color. */
    color?: string;
    /** Line width in px. Default: 2. */
    width?: number;
    /** Whether the lines are dashed. Default: false. */
    dashed?: boolean;
  };
  /** Yes/No instruction areas. */
  yesNo?: {
    /** Pixel diameter of each circle. Default: 80. */
    size?: number;
  };
}

/**
 * Per-experiment-task script. Each task under `experiments/<task-id>/`
 * exports a TaskSketch describing how to render that task's
 * task-specific visuals on top of the common base scene.
 *
 * Sketches are *pure*: they read from the per-frame `SketchScene` and
 * draw to `p`. State (cursors, averages, target positions, etc.) flows
 * from React → scene → sketch. Sketches MAY keep their own internal
 * animation state by closing over module-level variables, but the
 * canonical data path is scene-driven.
 */
/**
 * Per-frame output of a sketch trajectory function. Returned by
 * {@link TaskSketchTrajectory.compute}. A null return suppresses the
 * publish for that frame (useful for "gap" phases in a trajectory).
 */
export type TrajectoryFrameOutput = {
  x: number;
  y: number;
  shape?: 'triangle' | 'circle' | 'square';
  color?: string;
} | null;

/**
 * Free-form parameter bag passed from the server agent into the sketch's
 * trajectory function. The agent's `publishSketchTrajectory(params, ...)`
 * helper bundles whatever the experiment script wants (e.g. `period`,
 * `radius`, `amplitude`) and forwards it verbatim via the
 * `startSketchTrajectory` control message. The sketch interprets the
 * fields it needs.
 */
export type TrajectoryParams = Record<string, unknown>;

/**
 * Sketch-declared target trajectory. When the server agent sends a
 * `startSketchTrajectory(params)` control message, the admin client looks
 * up the active sketch's `trajectory` block and calls `compute()` every
 * `intervalMs` (default 50ms / 20Hz). Each non-null return is published
 * on the LiveKit `target` topic so participants see the moving target.
 *
 * The server still owns *when* the trajectory starts and stops; the
 * sketch owns the **motion equation**. Tasks that previously relied on
 * server-computed circle orbits (`publishCircleTargetForDuration`) can
 * migrate to this path to let researchers customize the trajectory
 * without server-side changes.
 *
 * Requires an admin tab to be present (admin is the only client that
 * publishes trajectory positions). Without admin, the trajectory simply
 * doesn't appear — same degradation profile as reaching's avg-cursor
 * offset paradigm.
 */
export interface TaskSketchTrajectory {
  /**
   * Per-frame target position. `elapsedMs` is milliseconds since the
   * most recent `startSketchTrajectory`. Return null to skip publishing
   * this frame.
   */
  compute(elapsedMs: number, params: TrajectoryParams): TrajectoryFrameOutput;
  /** Publish interval in ms. Default 50 (20Hz, matches legacy server-side rate). */
  intervalMs?: number;
}

/**
 * Read-only context passed into a sketch's `hit.detect` function. The
 * sketch inspects the latest cursor/average/target state and returns
 * true when the trial-end condition is met.
 *
 * The sketch is free to use any geometry: Euclidean distance (the
 * legacy `waitForAvgCursorNear` behavior), rectangular regions, polygon
 * containment, or even time-conditional predicates. The hit fires once
 * per `startSketchHitDetector` cycle — admin client stops polling after
 * the first fire and POSTs the configured event to the server.
 */
export interface HitDetectCtx {
  /** Displayed average cursor (raw − offset). null when no cursors. */
  averageCursor: { x: number; y: number } | null;
  /** Raw average cursor (un-offset). Useful for offset-aware tasks. */
  rawAverageCursor: { x: number; y: number } | null;
  /** Latest target as set on TARGET_TOPIC. null if no target visible. */
  target: P5Target | null;
  /** Per-group displayed averages (empty map if no grouping). */
  groupAverages: ReadonlyMap<number, { x: number; y: number }>;
  /**
   * Task-specific parameters passed by the server agent's
   * `startSketchHitDetector(params)` call. The shape is whatever the
   * agent's experiment script chose — read fields by name. For reaching
   * the agent passes `{ threshold }`; new tasks may pass any combination
   * the sketch needs to evaluate its predicate.
   */
  params: Record<string, unknown>;
  /** Milliseconds since the most recent `startSketchHitDetector`. */
  elapsedMs: number;
}

/**
 * Sketch-declared hit detector. When the server agent sends
 * `startSketchHitDetector`, the admin client looks up the active sketch's
 * `hit` block and calls `detect()` every `intervalMs` (default 50ms /
 * 20Hz). The first frame where `detect` returns true triggers a POST to
 * the server's `/agent/sketch-event` endpoint with the configured
 * `eventName`; the server's `waitForSketchEvent(name, ...)` resolves on
 * receipt.
 *
 * This unblocks any hit geometry (rectangles, polygons, custom temporal
 * conditions) without touching the server. The server agent is still the
 * orchestrator — it decides when to start and stop hit detection per
 * trial — but the *what counts as a hit* logic lives entirely in the
 * sketch file.
 *
 * Requires an admin tab. No admin → no hit events → server agent's
 * `waitForSketchEvent` will timeout at the configured `timeoutMs`.
 */
export interface TaskSketchHit {
  /**
   * Per-frame predicate. Return true when the trial-end condition is met.
   * Called repeatedly until it returns true OR the agent calls
   * `stopSketchHitDetector`.
   */
  detect(ctx: HitDetectCtx): boolean;
  /**
   * Event name sent to server when `detect` returns true. The server's
   * `waitForSketchEvent(name, ...)` must be called with the same name.
   * Default: `'hit'`.
   */
  eventName?: string;
  /** Polling interval in ms. Default 50 (20Hz). */
  intervalMs?: number;
}

/**
 * Per-task input transformation parameters. Currently the only field is
 * `cursorGain` (multiplier applied to pointer-lock delta before the
 * existing visuomotor rotation matrix). Researchers can extend this
 * shape in the future for custom input mappings.
 */
export interface TaskSketchInputs {
  /**
   * Cursor input gain. Multiplied into the per-frame normalized delta
   * (`dxNorm`, `dyNorm`) before any visuomotor rotation in
   * `handlePointerEvent`. Applied only while pointer-lock is active —
   * non-pointer-lock paths are unaffected.
   *
   * Default: 1.0 (no scaling). Set < 1 to slow the participant cursor,
   * > 1 to speed it up. The same gain is applied uniformly to every
   * participant in the room when this task is active.
   */
  cursorGain?: number;
}

export interface TaskSketch {
  /** Stable id, matches the directory name and ExperimentTaskType. */
  id: ExperimentTaskType;
  /** Human-readable label (used by debug/devtools). */
  label: string;
  /**
   * The TaskMode values this sketch's behavior applies to. The registry
   * uses these to dispatch by TaskMode from the client (which doesn't
   * know the experiment-task type directly).
   */
  appliesTo: TaskMode[];
  /**
   * Optional per-task visual style declaration. When provided, App.tsx's
   * `p5StageXxx` memos read these values in preference to the legacy
   * app-state defaults. Lets a single sketch file fully describe the
   * visual look of one experiment task. See {@link TaskSketchStyle} for
   * the priority chain.
   */
  style?: TaskSketchStyle;
  /**
   * Optional input transformation parameters (cursor gain, etc.) applied
   * client-side in pointer-lock mode. Lets the sketch own per-task input
   * behavior. See {@link TaskSketchInputs}.
   */
  inputs?: TaskSketchInputs;
  /**
   * Optional sketch-declared defaults for the server agent's
   * `ExperimentConfig`. When the researcher selects this task type in
   * AgentAdmin, these values pre-fill the form (overriding any previous
   * values for matched fields). Lets the sketch own task-specific
   * positions / thresholds / phase counts / display modes.
   *
   * The server agent remains the runtime authority — it executes whatever
   * config the AgentAdmin form ultimately posts. This block only changes
   * the UI default. Researchers can still override anything in the form
   * before clicking Save / Start.
   */
  defaults?: Partial<ExperimentConfig>;
  /**
   * Optional sketch-declared target trajectory. When defined, the admin
   * client computes and publishes target positions for this task while
   * the agent's `publishSketchTrajectory(params, durationMs)` window is
   * active. See {@link TaskSketchTrajectory}.
   */
  trajectory?: TaskSketchTrajectory;
  /**
   * Optional sketch-declared hit detector. When defined, the admin client
   * polls `hit.detect(ctx)` while the agent's `startSketchHitDetector` is
   * active, POSTing the configured event to the server on first hit.
   * See {@link TaskSketchHit}.
   */
  hit?: TaskSketchHit;
  /**
   * Optional one-time setup when this sketch becomes active. Useful
   * for resetting internal animation state.
   */
  onActivate?(p: p5): void;
  /** Optional cleanup when a different sketch takes over. */
  onDeactivate?(p: p5): void;
  /**
   * Per-frame draw call. Runs AFTER `drawBaseScene` — base draws
   * cursors / averages / lines / yes-no, then this layers task-specific
   * visuals (target shape, guide circle, custom overlays, …) on top.
   */
  drawTaskLayer(p: p5, scene: SketchScene, coords: CoordMap): void;
}
