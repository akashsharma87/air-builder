// Draw mode: a diagram board you sketch on in the air.
// Strokes snap into rectangles, ellipses, triangles and arrows; an arrow drawn
// from one shape to another becomes a connector that follows when you move them.
import { bbox, recognize } from "./recognize.js";

const SHAPES = new Set(["rect", "ellipse", "triangle"]);
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function bounds(it) {
  if (it.type === "rect") return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.type === "ellipse") return { x: it.cx - it.rx, y: it.cy - it.ry, w: it.rx * 2, h: it.ry * 2 };
  if (it.type === "triangle" || it.type === "path") return bbox(it.pts);
  if (it.type === "arrow") return bbox([{ x: it.x1, y: it.y1 }, { x: it.x2, y: it.y2 }]);
  return { x: 0, y: 0, w: 0, h: 0 };
}

const center = (it) => {
  const b = bounds(it);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};

function contains(it, p, pad = 0) {
  const b = bounds(it);
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

function distToSegment(p, a, b) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return d(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

/** Blends two #rrggbb colours (t = 0 → a, 1 → b). */
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

function inside(it, p) {
  if (it.type === "rect") return p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h;
  if (it.type === "ellipse") return ((p.x - it.cx) / Math.max(1, it.rx)) ** 2 + ((p.y - it.cy) / Math.max(1, it.ry)) ** 2 <= 1;
  if (it.type === "triangle") {
    const [a, b, c] = it.pts;
    const s = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = s(p, a, b);
    const d2 = s(p, b, c);
    const d3 = s(p, c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }
  return false;
}

/** Distance from p to the outline of a shape. */
function edgeDistance(it, p) {
  if (it.type === "rect") {
    const corners = [
      { x: it.x, y: it.y },
      { x: it.x + it.w, y: it.y },
      { x: it.x + it.w, y: it.y + it.h },
      { x: it.x, y: it.y + it.h },
    ];
    return Math.min(...corners.map((c, n) => distToSegment(p, c, corners[(n + 1) % 4])));
  }
  if (it.type === "ellipse") {
    const r = Math.sqrt(((p.x - it.cx) / Math.max(1, it.rx)) ** 2 + ((p.y - it.cy) / Math.max(1, it.ry)) ** 2);
    return Math.abs(r - 1) * Math.min(it.rx, it.ry);
  }
  if (it.type === "triangle") {
    const [a, b, c] = it.pts;
    return Math.min(distToSegment(p, a, b), distToSegment(p, b, c), distToSegment(p, c, a));
  }
  return Infinity;
}

/** Where a ray from the shape's centre towards (dx, dy) leaves the shape. */
function edgePoint(it, dx, dy) {
  const c = center(it);
  const b = bounds(it);
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let t;
  if (it.type === "ellipse") t = 1 / Math.sqrt((ux / Math.max(1, it.rx)) ** 2 + (uy / Math.max(1, it.ry)) ** 2);
  else t = Math.min(Math.abs(ux) > 1e-6 ? b.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? b.h / 2 / Math.abs(uy) : Infinity);
  return { x: c.x + ux * (t + 6), y: c.y + uy * (t + 6) };
}

function translate(it, dx, dy) {
  if (it.type === "rect") {
    it.x += dx;
    it.y += dy;
  } else if (it.type === "ellipse") {
    it.cx += dx;
    it.cy += dy;
  } else if (it.type === "triangle" || it.type === "path") {
    for (const p of it.pts) {
      p.x += dx;
      p.y += dy;
    }
  } else if (it.type === "arrow") {
    it.x1 += dx;
    it.y1 += dy;
    it.x2 += dx;
    it.y2 += dy;
  }
}

export class DrawBoard {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.items = [];
    this.history = [];
    this.stroke = null;
    this.moving = null;
    this.color = "#00e5ff";
    this.nextId = 1;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.dpr = dpr;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
  }

  snapshot() {
    this.history.push(JSON.stringify({ items: this.items, nextId: this.nextId }));
    if (this.history.length > 60) this.history.shift();
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    const s = JSON.parse(prev);
    this.items = s.items;
    this.nextId = s.nextId;
    return true;
  }

  clear() {
    if (!this.items.length) return false;
    this.snapshot();
    this.items = [];
    return true;
  }

  /* ---- drawing ---- */

  beginStroke(p) {
    this.stroke = { pts: [{ x: p.x, y: p.y }], color: this.color };
  }

  extendStroke(p) {
    if (!this.stroke) return this.beginStroke(p);
    const last = this.stroke.pts[this.stroke.pts.length - 1];
    if (d(last, p) > 1.5) this.stroke.pts.push({ x: p.x, y: p.y });
  }

  cancelStroke() {
    this.stroke = null;
  }

  /** Finishes the stroke; returns the new item (or null if it was too small). */
  endStroke() {
    const now = performance.now(); // animation runs on the screen clock
    const s = this.stroke;
    this.stroke = null;
    if (!s) return null;
    const shape = recognize(s.pts);
    if (!shape) return null;
    this.snapshot();
    let item = { ...shape, id: this.nextId++, color: s.color, born: now };
    if (shape.type === "arrow") {
      const from = this.shapeAt({ x: shape.x1, y: shape.y1 }, 24);
      const to = this.shapeAt({ x: shape.x2, y: shape.y2 }, 24);
      if (from && to && from !== to) item = { type: "link", id: item.id, from: from.id, to: to.id, color: s.color, born: now };
    }
    this.items.push(item);
    return item;
  }

  /* ---- picking ---- */

  shapeAt(p, pad = 0) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (SHAPES.has(it.type) && contains(it, p, pad)) return it;
    }
    return null;
  }

  itemAt(p) {
    const shape = this.shapeAt(p, 10);
    if (shape) return shape;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type === "arrow" && distToSegment(p, { x: it.x1, y: it.y1 }, { x: it.x2, y: it.y2 }) < 16) return it;
      if (it.type === "path" && it.pts.some((q, k) => k && distToSegment(p, it.pts[k - 1], q) < 16)) return it;
      if (it.type === "link") {
        const seg = this.linkSegment(it);
        if (seg && distToSegment(p, seg.a, seg.b) < 16) return it;
      }
    }
    return null;
  }

  /* ---- moving + erasing ---- */

  startMove(item, p) {
    if (!item || item.type === "link") return false;
    this.snapshot();
    this.moving = { item, last: { x: p.x, y: p.y } };
    return true;
  }

  moveTo(p) {
    if (!this.moving) return;
    translate(this.moving.item, p.x - this.moving.last.x, p.y - this.moving.last.y);
    this.moving.last = { x: p.x, y: p.y };
  }

  /** Ends a move. Returns true if the item was dropped in the bin. */
  endMove(inBin = false) {
    const m = this.moving;
    this.moving = null;
    if (m && inBin) {
      this.remove(m.item, false);
      return true;
    }
    return false;
  }

  remove(item, record = true) {
    if (!item) return;
    if (record) this.snapshot();
    this.items = this.items.filter((it) => it !== item && !(it.type === "link" && (it.from === item.id || it.to === item.id)));
  }

  /* ---- Make 3D: turn the drawing into Lego cells ---- */

  /**
   * Stands the drawing up as a Lego wall, exactly as drawn: screen x → across,
   * screen y → height (bottom of the drawing on the floor). Outlines are 2 bricks deep
   * so they stand out; filled areas and lines are 1 brick deep.
   * Returns [{ i, j, k, color }].
   */
  toCells(grid = 15, maxHeight = 14) {
    const lines = [];
    const shapes = [];
    for (const it of this.items) {
      if (SHAPES.has(it.type)) shapes.push(it);
      else if (it.type === "arrow") lines.push({ pts: [{ x: it.x1, y: it.y1 }, { x: it.x2, y: it.y2 }], color: it.color });
      else if (it.type === "path") lines.push({ pts: it.pts, color: it.color });
      else if (it.type === "link") {
        const seg = this.linkSegment(it);
        if (seg) lines.push({ pts: [seg.a, seg.b], color: it.color });
      }
    }
    const allPts = [...shapes.flatMap((s) => { const b = bounds(s); return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]; }), ...lines.flatMap((l) => l.pts)];
    if (!allPts.length) return [];

    const u = bbox(allPts);
    const half = Math.floor(grid / 2);
    const cell = Math.max(u.w / (grid - 3), u.h / (maxHeight - 1), 1);
    const cx = u.x + u.w / 2;
    const bottom = u.y + u.h;
    const near = cell * 0.6;
    const cells = new Map(); // "i,j" -> { depth, color }
    const put = (i, j, depth, color) => {
      const key = `${i},${j}`;
      const prev = cells.get(key);
      if (!prev || depth >= prev.depth) cells.set(key, { depth, color });
    };

    for (let i = -half; i <= half; i++) {
      for (let j = 0; j < maxHeight; j++) {
        const p = { x: cx + i * cell, y: bottom - j * cell };
        for (const s of shapes) {
          if (edgeDistance(s, p) < near) put(i, j, 2, s.color);
          else if (inside(s, p)) put(i, j, 1, mix(s.color, "#ffffff", 0.55));
        }
        for (const l of lines) {
          if (l.pts.some((q, n) => n && distToSegment(p, l.pts[n - 1], q) < near)) put(i, j, 1, l.color);
        }
      }
    }

    const out = [];
    for (const [key, { depth, color }] of cells) {
      const [i, j] = key.split(",").map(Number);
      for (let k = 0; k < depth; k++) out.push({ i, j, k: -k, color });
    }
    return out;
  }

  /* ---- rendering ---- */

  linkSegment(link) {
    const a = this.items.find((it) => it.id === link.from);
    const b = this.items.find((it) => it.id === link.to);
    if (!a || !b) return null;
    const ca = center(a);
    const cb = center(b);
    return { a: edgePoint(a, cb.x - ca.x, cb.y - ca.y), b: edgePoint(b, ca.x - cb.x, ca.y - cb.y) };
  }

  render(now, { hover = null, erase = null } = {}) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const it of this.items) {
      const t = Math.min(1, (now - (it.born || 0)) / 260);
      const grow = 1 + (1 - t) * 0.08;
      ctx.save();
      if (grow !== 1) {
        const c = it.type === "link" ? { x: 0, y: 0 } : center(it);
        ctx.translate(c.x, c.y);
        ctx.scale(grow, grow);
        ctx.translate(-c.x, -c.y);
      }
      this.drawItem(it, it === erase ? "#ff4d5e" : it.color);
      ctx.restore();
      if (it === hover || it === erase) this.drawHighlight(it, it === erase ? "#ff4d5e" : "#ffffff");
    }

    if (this.stroke && this.stroke.pts.length > 1) {
      ctx.save();
      this.glow(this.stroke.color, 4);
      ctx.beginPath();
      this.stroke.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();
    }
  }

  glow(color, width = 3) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
  }

  drawItem(it, color) {
    const { ctx } = this;
    this.glow(color);
    const fill = () => {
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.shadowBlur = 0;
      ctx.fill();
      ctx.restore();
      ctx.stroke();
    };
    if (it.type === "rect") {
      ctx.beginPath();
      ctx.roundRect(it.x, it.y, it.w, it.h, 10);
      fill();
    } else if (it.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(it.cx, it.cy, Math.max(1, it.rx), Math.max(1, it.ry), 0, 0, Math.PI * 2);
      fill();
    } else if (it.type === "triangle") {
      ctx.beginPath();
      it.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      fill();
    } else if (it.type === "path") {
      ctx.beginPath();
      it.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else if (it.type === "arrow") {
      this.drawArrow({ x: it.x1, y: it.y1 }, { x: it.x2, y: it.y2 });
    } else if (it.type === "link") {
      const seg = this.linkSegment(it);
      if (seg) this.drawArrow(seg.a, seg.b, true);
    }
  }

  drawArrow(a, b, dashed = false) {
    const { ctx } = this;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = 14;
    ctx.beginPath();
    if (dashed) ctx.setLineDash([10, 8]);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x - Math.cos(ang) * head * 0.6, b.y - Math.sin(ang) * head * 0.6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  drawHighlight(it, color) {
    const { ctx } = this;
    let b = bounds(it);
    if (it.type === "link") {
      const seg = this.linkSegment(it);
      if (!seg) return;
      b = bbox([seg.a, seg.b]);
    }
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x - 10, b.y - 10, b.w + 20, b.h + 20);
    ctx.restore();
  }
}
