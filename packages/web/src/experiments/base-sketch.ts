import type p5 from 'p5';
import type { CoordMap, SketchScene } from './types';
import { drawBoundaryBox, drawDot, drawLine } from './shared/draw';
import { drawYesNoAreas } from './shared/yes-no';

/**
 * The always-on visual baseline shared by every experiment task. Renders:
 *   1. background / clear
 *   2. optional dashed boundary box (replay)
 *   3. avg→cursor connector lines (when `displayMode === all-with-avg-lines`)
 *   4. participant + werewolf cursors
 *   5. average / per-group average cursors
 *   6. Yes/No instruction areas
 *
 * Target shapes and guide circles are *task-specific* and therefore drawn
 * by each `TaskSketch.drawTaskLayer` on top of this baseline. Splitting
 * the render this way gives per-task sketches a clean canvas for custom
 * decoration without duplicating the cursor / yes-no plumbing.
 */
export function drawBaseScene(
  p: p5,
  scene: SketchScene,
  c: CoordMap,
  beforeDots?: () => void,
) {
  if (scene.background) {
    p.background(scene.background);
  } else {
    p.clear();
  }

  if (scene.showBoundaryBox) drawBoundaryBox(p, c);

  for (const ln of scene.lines) drawLine(p, ln, c);
  beforeDots?.();
  for (const dot of scene.cursors) drawDot(p, dot, c);
  for (const dot of scene.averages) drawDot(p, dot, c);

  if (scene.yesNo) drawYesNoAreas(p, scene.yesNo, c);
}
