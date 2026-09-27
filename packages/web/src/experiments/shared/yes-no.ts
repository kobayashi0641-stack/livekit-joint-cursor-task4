import type p5 from 'p5';
import type { CoordMap, P5YesNo } from '../types';

/**
 * Common Yes/No instruction component.
 *
 * Used by `common-flow`'s 11 instruction steps (and per-task instructions)
 * to confirm participant comprehension: the agent broadcasts
 * `setYesNoAreas`, every client paints the pair, and the first cursor
 * to enter the Yes circle advances the agent's flow. The same component
 * is reused across every experiment task — that's why it lives in
 * `shared/` rather than under a task directory.
 *
 * Visual contract:
 *  - Yes: blue circle (#2563eb outline, rgba(59,130,246,0.7) fill) with
 *    white bold "Yes" centered.
 *  - No: red circle (#dc2626 outline, rgba(239,68,68,0.7) fill) with
 *    white bold "No" centered.
 *  - Positions and pixel size come from the scene (set server-side).
 */
export function drawYesNoAreas(p: p5, yn: P5YesNo, c: CoordMap) {
  drawCircle(p, c, yn, 'Yes', yn.yesPosition, 'rgba(59, 130, 246, 0.7)', '#2563eb');
  drawCircle(p, c, yn, 'No', yn.noPosition, 'rgba(239, 68, 68, 0.7)', '#dc2626');
}

function drawCircle(
  p: p5,
  c: CoordMap,
  yn: P5YesNo,
  text: string,
  pos: { x: number; y: number },
  fill: string,
  stroke: string,
) {
  const cx = c.sx(pos.x);
  const cy = c.sy(pos.y);
  p.push();
  p.fill(fill);
  p.stroke(stroke);
  p.strokeWeight(3);
  p.ellipse(cx, cy, yn.size, yn.size);
  p.noStroke();
  p.fill(255);
  p.textAlign(p.CENTER, p.CENTER);
  p.textStyle(p.BOLD);
  p.textSize(20);
  p.text(text, cx, cy);
  p.textAlign(p.LEFT, p.TOP);
  p.textStyle(p.NORMAL);
  p.pop();
}
