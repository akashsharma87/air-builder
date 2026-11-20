// Hand reading for MediaPipe's 21 landmarks. Pure maths, no DOM.
//
// Landmarks: 0 wrist · thumb 1–4 · index 5–8 · middle 9–12 · ring 13–16 · pinky 17–20.
// Coordinates are normalised to the camera image. Distances are measured in
// pixels and divided by palm length, so thresholds work at any distance.

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b, w, h) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
const mirror = (p) => ({ x: 1 - p.x, y: p.y });

/** One frame of the hand, in mirrored camera space (like looking in a mirror). */
export function readHand(lm, w = 1, h = 1) {
  const palm = Math.max(1e-6, dist(lm[0], lm[9], w, h));
  const ext = [8, 12, 16, 20].map((t) => dist(lm[t], lm[0], w, h) / palm);
  const palmPts = [0, 5, 9, 13, 17].map((i) => lm[i]);
  return {
    palm,
    ext, // fingertip-to-wrist ÷ palm length: index, middle, ring, pinky
    pinchRatio: dist(lm[4], lm[8], w, h) / palm,
    tip: mirror(lm[8]),
    knuckle: mirror(lm[5]),
    pinchPoint: mirror({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }),
    palmCenter: mirror({ x: palmPts.reduce((s, p) => s + p.x, 0) / 5, y: palmPts.reduce((s, p) => s + p.y, 0) / 5 }),
  };
}

/**
 * point: only the index finger out · open: all fingers out · fist: all folded
 * two: index + middle out · pinch: thumb touching index · other: anything else
 */
export function classifyPose(r, pinching) {
  if (pinching) return "pinch";
  const [i, m, rg, p] = r.ext;
  const up = (e, t = 1.55) => e > t;
  const down = (e) => e < 1.3;
  if (up(i) && up(m) && up(rg) && up(p, 1.4)) return "open";
  if (up(i) && down(m) && down(rg) && down(p)) return "point";
  if (up(i) && up(m) && down(rg) && down(p)) return "two";
  if (down(i) && down(m) && down(rg) && down(p)) return "fist";
  return "other";
}

/** Pinch with hysteresis so it doesn't flicker. Ignores a curled index (fist). */
export class PinchLatch {
  constructor(on = 0.32, off = 0.5) {
    this.on = on;
    this.off = off;
    this.active = false;
  }
  update(r) {
    if (!this.active && r.pinchRatio < this.on && r.ext[0] > 1.1) this.active = true;
    else if (this.active && r.pinchRatio > this.off) this.active = false;
    return this.active;
  }
  reset() {
    this.active = false;
  }
}

/** A pose must repeat for `frames` frames before it counts. */
export class PoseStabilizer {
  constructor(frames = 2) {
    this.frames = frames;
    this.candidate = "none";
    this.count = 0;
    this.stable = "none";
  }
  update(raw) {
    if (raw === this.candidate) this.count++;
    else {
      this.candidate = raw;
      this.count = 1;
    }
    if (this.count >= this.frames || raw === "pinch") this.stable = raw;
    return this.stable;
  }
  reset() {
    this.candidate = this.stable = "none";
    this.count = 0;
  }
}

/** One Euro filter: smooth when the hand is still, responsive when it moves fast. */
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 2.5, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, tSec) {
    if (this.x === null) {
      this.x = x;
      this.t = tSec;
      return x;
    }
    const dt = Math.max(1e-3, tSec - this.t);
    this.t = tSec;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
}
