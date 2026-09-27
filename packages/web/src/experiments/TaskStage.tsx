import p5 from 'p5';
import { useEffect, useRef } from 'react';

import { drawBaseScene } from './base-sketch';
import { getSketchByExperimentTask, getSketchByTaskMode } from './registry';
import { drawGuide, drawTarget } from './shared/draw';
import {
  DEFAULT_VIEWPORT,
  type CoordMap,
  type ExperimentTaskType,
  type P5Dot,
  type P5Guide,
  type P5Line,
  type P5Target,
  type P5YesNo,
  type SketchScene,
  type TaskMode,
  type TaskSketch,
  type Viewport,
} from './types';

export type {
  CoordMap,
  ExperimentTaskType,
  P5Dot,
  P5Guide,
  P5Line,
  P5Target,
  P5YesNo,
  SketchScene,
  TaskMode,
  TaskSketch,
  Viewport,
} from './types';

export interface TaskStageProps {
  viewport?: Viewport;
  /** CSS background color. Omit to clear to transparent each frame. */
  background?: string;
  /** Draw the dashed [0,1] reference rectangle (used by replay). */
  showBoundaryBox?: boolean;

  cursors?: P5Dot[];
  averages?: P5Dot[];
  lines?: P5Line[];
  target?: P5Target | null;
  guide?: P5Guide | null;
  yesNo?: P5YesNo | null;

  /**
   * Current client-side rendering mode. Drives which experiment-task
   * sketch is invoked. If null/undefined, the framework falls back to
   * a generic render (paint `scene.target` / `scene.guide` if present).
   */
  taskMode?: TaskMode | null;
  /**
   * Optional explicit experiment task type. Takes precedence over
   * `taskMode` lookup — useful when the caller knows the exact task
   * (e.g. via `/agent/config` or a future server broadcast) and wants
   * to disambiguate cases where several tasks share a `taskMode`
   * (circle-target-tracking vs group-circle-target-tracking).
   */
  experimentTaskType?: ExperimentTaskType | null;
}

/**
 * p5.js-backed stage renderer. Mounts a single `<canvas>` that fills
 * its absolute-positioned wrapper, observes the wrapper for resize,
 * and redraws every frame at 60 fps:
 *
 *   1. `drawBaseScene` — cursors, averages, lines, yes-no, boundary
 *   2. the active `TaskSketch.drawTaskLayer` — task-specific visuals
 *      (target shape, guide circle, …). Falls back to a generic
 *      target/guide draw when no sketch matches.
 *
 * Props are read through a ref each frame, so updating arrays
 * in-place is safe; no re-mount needed.
 *
 * The wrapper sets `pointer-events: none` so the parent container
 * keeps full control over pointer / lock handling.
 */
export function TaskStage(props: TaskStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const p5InstanceRef = useRef<p5 | null>(null);
  const activeSketchRef = useRef<TaskSketch | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sketch = (p: p5) => {
      p.setup = () => {
        const w = Math.max(container.clientWidth, 1);
        const h = Math.max(container.clientHeight, 1);
        const c = p.createCanvas(w, h);
        c.style('display', 'block');
        c.style('pointer-events', 'none');
        c.style('position', 'absolute');
        c.style('top', '0');
        c.style('left', '0');
        p.frameRate(60);
        p.textFont('Arial');
        p.textAlign(p.LEFT, p.TOP);
      };

      p.draw = () => {
        const cur = propsRef.current;
        const vp = cur.viewport ?? DEFAULT_VIEWPORT;
        const W = p.width;
        const H = p.height;
        const coords: CoordMap = {
          sx: (x: number) => ((x - vp.minX) / vp.rangeX) * W,
          sy: (y: number) => ((y - vp.minY) / vp.rangeY) * H,
          W,
          H,
        };

        const scene: SketchScene = {
          viewport: vp,
          background: cur.background,
          showBoundaryBox: cur.showBoundaryBox,
          taskMode: cur.taskMode ?? null,
          cursors: cur.cursors ?? [],
          averages: cur.averages ?? [],
          lines: cur.lines ?? [],
          target: cur.target ?? null,
          guide: cur.guide ?? null,
          yesNo: cur.yesNo ?? null,
        };

        // Resolve which per-task sketch is active. Explicit experiment
        // task wins; otherwise fall back to TaskMode-based lookup.
        const next = getSketchByExperimentTask(cur.experimentTaskType ?? null)
          ?? getSketchByTaskMode(cur.taskMode ?? null);

        const prev = activeSketchRef.current;
        if (next !== prev) {
          prev?.onDeactivate?.(p);
          next?.onActivate?.(p);
          activeSketchRef.current = next;
        }

        if (next && (next.id === 'shared-single-cursor-control' || next.id === 'cursor-control-20260706' || next.id === 'task8' || next.id === 'task9')) {
          drawBaseScene(p, scene, coords, () => next.drawTaskLayer(p, scene, coords));
        } else if (next) {
          drawBaseScene(p, scene, coords);
          next.drawTaskLayer(p, scene, coords);
        } else {
          drawBaseScene(p, scene, coords);
          // No registered sketch (wait phase / random-target-tracking /
          // replay). Render scene.target / scene.guide generically so
          // these modes still display correctly.
          if (scene.target) drawTarget(p, scene.target, coords);
          if (scene.guide) drawGuide(p, scene.guide, coords);
        }
      };
    };

    p5InstanceRef.current = new p5(sketch, container);

    const ro = new ResizeObserver(() => {
      const inst = p5InstanceRef.current;
      if (!inst) return;
      const w = Math.max(container.clientWidth, 1);
      const h = Math.max(container.clientHeight, 1);
      if (inst.width !== w || inst.height !== h) {
        inst.resizeCanvas(w, h);
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      const inst = p5InstanceRef.current;
      if (inst && activeSketchRef.current?.onDeactivate) {
        activeSketchRef.current.onDeactivate(inst);
      }
      activeSketchRef.current = null;
      inst?.remove();
      p5InstanceRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
  );
}
