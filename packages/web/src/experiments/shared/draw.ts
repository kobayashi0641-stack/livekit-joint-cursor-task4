import type p5 from 'p5';
import type { CoordMap, P5Dot, P5Guide, P5Line, P5Target } from '../types';

type CanvasCtx = CanvasRenderingContext2D;

function rawCtx(p: p5): CanvasCtx {
  return (p as unknown as { drawingContext: CanvasCtx }).drawingContext;
}

/**
 * Dashed [0,1] reference rectangle. Used by ReplayModal so the recorded
 * trajectory bounds are easy to read against the live stage's coordinate
 * system.
 */
export function drawBoundaryBox(p: p5, c: CoordMap) {
  const ctx = rawCtx(p);
  p.push();
  p.fill('rgba(255, 255, 255, 0.3)');
  p.stroke('rgba(100, 116, 139, 0.4)');
  p.strokeWeight(2);
  ctx.setLineDash([6, 4]);
  const x0 = c.sx(0);
  const y0 = c.sy(0);
  p.rect(x0, y0, c.sx(1) - x0, c.sy(1) - y0);
  ctx.setLineDash([]);
  p.pop();
}

export function drawLine(p: p5, ln: P5Line, c: CoordMap) {
  const ctx = rawCtx(p);
  p.push();
  p.stroke(ln.color);
  p.strokeWeight(ln.width);
  if (ln.dashed) ctx.setLineDash([4, 4]);
  p.line(c.sx(ln.x1), c.sy(ln.y1), c.sx(ln.x2), c.sy(ln.y2));
  if (ln.dashed) ctx.setLineDash([]);
  p.pop();
}

export function drawDot(p: p5, dot: P5Dot, c: CoordMap) {
  const cx = c.sx(dot.x);
  const cy = c.sy(dot.y);

  p.push();
  if (dot.opacity !== undefined && dot.opacity < 1) {
    const col = p.color(dot.fill);
    col.setAlpha(Math.max(0, Math.min(1, dot.opacity)) * 255);
    p.fill(col);
  } else {
    p.fill(dot.fill);
  }
  if (dot.stroke && (dot.strokeWidth ?? 0) > 0) {
    p.stroke(dot.stroke);
    p.strokeWeight(dot.strokeWidth!);
  } else {
    p.noStroke();
  }
  p.ellipse(cx, cy, dot.diameter, dot.diameter);

  if (dot.label) {
    p.noStroke();
    const labelY = cy + dot.diameter / 2 + 2;
    p.textSize(11);
    p.textStyle(p.NORMAL);
    p.fill(dot.label.color ?? 'rgba(30, 41, 59, 0.6)');
    p.text(dot.label.text, cx + 4, labelY);
    if (dot.label.extra) {
      const mainW = p.textWidth(dot.label.text);
      p.fill(dot.label.extraColor ?? dot.label.color ?? 'rgba(30, 41, 59, 0.6)');
      p.textSize(10);
      p.text(dot.label.extra, cx + 4 + mainW + 4, labelY);
    }
  }

  p.pop();
}

/**
 * Primitive target renderer. Each per-task sketch composes this with
 * its own scene.target. The supported shapes (triangle / circle /
 * square) cover all existing tasks and the recorded replay shapes.
 */
export function drawTarget(p: p5, t: P5Target, c: CoordMap) {
  const cx = c.sx(t.x);
  const cy = c.sy(t.y);
  p.push();
  p.fill(t.fill);
  p.noStroke();

  if (t.shape === 'circle') {
    p.ellipse(cx, cy, t.size, t.size);
  } else if (t.shape === 'square') {
    p.rectMode(p.CENTER);
    p.rect(cx, cy, t.size, t.size);
    p.rectMode(p.CORNER);
  } else {
    // triangle pointing UP. Width = `size`, height ≈ size * 0.87, matching
    // the CSS border-trick proportions used by the original ViewerMode.
    const halfW = t.size / 2;
    const halfH = (t.size * 0.87) / 2;
    p.triangle(cx, cy - halfH, cx - halfW, cy + halfH, cx + halfW, cy + halfH);
  }
  p.pop();
}

/**
 * Hollow guide circle. The original CSS used percentages on width /
 * height independently so the box becomes an ellipse on non-square
 * stages; mirroring that keeps the guide unchanged at any aspect.
 */
export function drawGuide(p: p5, g: P5Guide, c: CoordMap) {
  const cx = c.sx(g.cx);
  const cy = c.sy(g.cy);
  const w = g.radius * 2 * c.W;
  const h = g.radius * 2 * c.H;
  p.push();
  p.noFill();
  p.stroke(g.stroke);
  p.strokeWeight(g.strokeWidth);
  p.ellipse(cx, cy, w, h);
  p.pop();
}
