// Turns a hand-drawn stroke into a clean shape, like a diagram tool.
// Points are screen pixels. Pure functions, no DOM.
//
// How it decides:
//   open stroke  -> straight enough? arrow : freehand path
//   closed stroke -> how much of its bounding box it fills:
//        ~1.0 rectangle · ~0.78 ellipse · ~0.5 triangle

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += d(pts[i - 1], pts[i]);
  return len;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Drops points closer than `minGap` px to the previous one. */
function dedupe(pts, minGap = 2) {
  const out = [];
  for (const p of pts) if (!out.length || d(out[out.length - 1], p) >= minGap) out.push({ x: p.x, y: p.y });
  return out;
}

/** Light moving-average smoothing for freehand paths. */
export function smooth(pts, k = 2) {
  return pts.map((_, i) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(pts.length - 1, i + k); j++) {
      sx += pts[j].x;
      sy += pts[j].y;
      n++;
    }
    return { x: sx / n, y: sy / n };
  });
}

/** Three corners of a rough triangle: farthest-point picks are robust to wobble. */
function triangleCorners(pts) {
  const c = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
  const far = (from) => pts.reduce((best, p) => (d(p, from) > d(best, from) ? p : best), pts[0]);
  const a = far(c);
  const b = far(a);
  const lineDist = (p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.max(1e-6, d(a, b));
  const c3 = pts.reduce((best, p) => (lineDist(p) > lineDist(best) ? p : best), pts[0]);
  return [a, b, c3].map((p) => ({ x: p.x, y: p.y }));
}

export function recognize(raw) {
  const pts = dedupe(raw);
  if (pts.length < 4) return null;
  const b = bbox(pts);
  const diag = Math.hypot(b.w, b.h);
  if (diag < 24) return null;

  const len = pathLength(pts);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = d(first, last);
  const closed = gap < Math.max(40, 0.3 * diag) && len > 1.8 * diag;

  if (!closed) {
    if (gap / len > 0.82) return { type: "arrow", x1: first.x, y1: first.y, x2: last.x, y2: last.y };
    return { type: "path", pts: smooth(pts) };
  }

  const fill = polygonArea(pts) / Math.max(1, b.w * b.h);
  if (fill >= 0.84) return { type: "rect", x: b.x, y: b.y, w: b.w, h: b.h };
  if (fill >= 0.63) return { type: "ellipse", cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2 };
  return { type: "triangle", pts: triangleCorners(pts) };
}
