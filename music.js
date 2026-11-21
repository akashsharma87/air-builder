// Music mode: draw lines in the air and a glowing playhead turns them into music.
// The playhead sweeps left → right over a 2-bar loop (32 sixteenth-note steps).
// Wherever it crosses a line, that line sings: height = pitch (C minor pentatonic,
// low at the bottom, so every combination sounds good), colour = instrument.
// A tiny tap leaves a drum ring instead: low = kick, middle = snare, high = hi-hat.

const STEPS = 32;
const SCALE = [0, 3, 5, 7, 10]; // C minor pentatonic
const NAMES = ["C", "Eb", "F", "G", "Bb"];
const LOW = 36; // C2

/** Every playable note, bottom to top: C2 … C6. */
export const NOTES = (() => {
  const out = [];
  for (let o = 0; o < 4; o++) SCALE.forEach((s, i) => out.push({ midi: LOW + o * 12 + s, name: NAMES[i] + (2 + o), root: i === 0 }));
  out.push({ midi: LOW + 48, name: "C6", root: true });
  return out;
})();

// Pitch area as a fraction of the screen height (keeps clear of the toolbar and hints).
const TOP = 0.18;
const BOTTOM = 0.93;

export const INSTRUMENTS = {
  "#7cff6b": { id: "keys", name: "Glass keys" },
  "#00e5ff": { id: "bell", name: "Bell" },
  "#ff3df2": { id: "pluck", name: "Pluck" },
  "#ffb300": { id: "bass", name: "Bass" },
  "#ff4d5e": { id: "lead", name: "Lead" },
  "#f2f5ff": { id: "pad", name: "Pad" },
};
const DRUM_NAMES = { kick: "Kick", snare: "Snare", hat: "Hi-hat" };
const TEMPOS = [80, 100, 120];
const PLAYHEAD = "#ff2fd6";
const NODE_COLORS = { peak: "#fff27a", valley: "#5ce8ff", corner: "#ffffff", cross: "#ff8af0" };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mod = (n, m) => ((n % m) + m) % m;
const wrapDx = (a, b) => mod(a - b + 0.5, 1) - 0.5;
const noteY = (i) => BOTTOM - (i / (NOTES.length - 1)) * (BOTTOM - TOP);
const noteIndex = (y) => clamp(Math.round(((BOTTOM - y) / (BOTTOM - TOP)) * (NOTES.length - 1)), 0, NOTES.length - 1);
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** Blends two #rrggbb colours (t = 0 → a, 1 → b). */
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** Points every `gap` along the polyline (normalised units). */
function densify(pts, gap = 0.004) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / gap));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Chaikin smoothing: rounds off hand jitter, keeps the ends. */
function smooth(pts, passes = 2) {
  let p = pts;
  for (let n = 0; n < passes && p.length > 2; n++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/**
 * Which notes a line plays on each step, and for how long.
 * Returns STEPS arrays of { n: note index, len: steps held }. A note that carries on
 * into the next step is held, not re-struck, so a flat line is one long note.
 */
function lineTriggers(pts) {
  const bands = Array.from({ length: STEPS }, () => []);
  let prev = -1;
  let run = null;
  for (const s of densify(pts)) {
    const st = mod(Math.round(s.x * STEPS), STEPS);
    if (st !== prev) {
      run = [];
      bands[st].push(run);
      prev = st;
    }
    run.push(s);
  }
  const notes = bands.map((runs, st) => {
    const set = new Set();
    for (const r of runs) {
      const idx = [...new Set(r.map((s) => noteIndex(s.y)))];
      if (idx.length <= 2) {
        // Mostly sideways: the note where the line is closest to the beat.
        let best = r[0];
        for (const s of r) if (Math.abs(wrapDx(s.x, st / STEPS)) < Math.abs(wrapDx(best.x, st / STEPS))) best = s;
        set.add(noteIndex(best.y));
      } else idx.forEach((i) => set.add(i)); // steep: strum every note it passes
    }
    let arr = [...set].sort((a, b) => a - b);
    if (arr.length > 4) arr = [0, 1, 2, 3].map((k) => arr[Math.round((k * (arr.length - 1)) / 3)]);
    return arr;
  });
  return notes.map((arr, st) =>
    arr.flatMap((n) => {
      const everywhere = notes.every((a) => a.includes(n));
      if (everywhere) return st === 0 ? [{ n, len: STEPS }] : [];
      if (notes[mod(st - 1, STEPS)].includes(n)) return []; // still held from the last step
      let len = 1;
      while (len < STEPS && notes[mod(st + len, STEPS)].includes(n)) len++;
      return [{ n, len }];
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Shape reading: peaks, valleys, corners and crossings                */
/* ------------------------------------------------------------------ */
// Every special point of a drawing gets its own sound, so the *shape* is the music:
//   peak   (top of an arch ∩)      → a sparkling arpeggio that climbs up
//   valley (bottom of a U / V)     → a deep 808 bass drop
//   corner (sharp bend / zigzag)   → a strummed chord stab (turn direction = strum direction)
//   cross  (two lines crossing)    → a shimmering crash with chimes

/** The polyline in pixels, resampled to one point every `gap` px. */
function resamplePx(pts, w, h, gap = 10) {
  const P = pts.map((p) => ({ x: p.x * w, y: p.y * h }));
  if (P.length < 2) return P;
  const out = [P[0]];
  let carry = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1];
    const b = P[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let d = gap - carry;
    while (d <= len) {
      out.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
      d += gap;
    }
    carry = len - (d - gap);
  }
  out.push(P[P.length - 1]);
  return out;
}

const hash = (x, y) => Math.abs(Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453));

function makeNode(type, p, w, h, extra = {}) {
  const x = p.x / w;
  const y = p.y / h;
  return { type, x, y, step: mod(Math.round(x * STEPS), STEPS), n: noteIndex(y), seed: hash(x, y), hitAt: -1, ...extra };
}

/** Peaks, valleys and sharp corners along one line. */
function findNodes(pts, w, h) {
  const P = resamplePx(pts, w, h);
  if (P.length < 5) return [];
  const nodes = [];

  // Signed turning angle at each point, measured over a short window.
  const k = 2;
  const turn = new Array(P.length).fill(0);
  for (let i = k; i < P.length - k; i++) {
    const a = Math.atan2(P[i].y - P[i - k].y, P[i].x - P[i - k].x);
    const b = Math.atan2(P[i + k].y - P[i].y, P[i + k].x - P[i].x);
    turn[i] = mod(b - a + Math.PI, Math.PI * 2) - Math.PI;
  }

  // Peaks and valleys: the line goes up then comes back down by at least T px (or vice versa).
  const T = 18;
  const extrema = [];
  let mode = null;
  let cand = 0;
  for (let i = 1; i < P.length; i++) {
    const y = P[i].y;
    if (mode === null) {
      if (y - P[0].y > T) [mode, cand] = ["down", i];
      else if (P[0].y - y > T) [mode, cand] = ["up", i];
    } else if (mode === "up") {
      if (y < P[cand].y) cand = i;
      else if (y - P[cand].y > T) {
        extrema.push({ i: cand, type: "peak" });
        [mode, cand] = ["down", i];
      }
    } else if (y > P[cand].y) cand = i;
    else if (P[cand].y - y > T) {
      extrema.push({ i: cand, type: "valley" });
      [mode, cand] = ["up", i];
    }
  }
  const sharpAt = (i) => {
    let s = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(P.length - 1, i + 2); j++) s = Math.max(s, Math.abs(turn[j]));
    return s;
  };
  for (const e of extrema) nodes.push(makeNode(e.type, P[e.i], w, h, { sharp: sharpAt(e.i), i: e.i }));

  // Corners: the strongest bend in its neighbourhood, sharper than ~35°, not already a peak/valley.
  for (let i = k; i < P.length - k; i++) {
    const s = Math.abs(turn[i]);
    if (s < 0.62) continue;
    let isMax = true;
    for (let j = i - 3; j <= i + 3; j++) if (j !== i && j >= 0 && j < P.length && Math.abs(turn[j]) > s) isMax = false;
    if (!isMax) continue;
    if (extrema.some((e) => Math.abs(e.i - i) <= 3)) continue;
    if (nodes.some((n) => n.type === "corner" && Math.abs(n.i - i) <= 3)) continue;
    nodes.push(makeNode("corner", P[i], w, h, { sharp: s, dir: Math.sign(turn[i]), i }));
  }
  return nodes.slice(0, 24);
}

/** Where lines cross each other (or a loop crosses itself). */
function findCrosses(lines, w, h) {
  const segs = lines.map((it) => {
    const P = resamplePx(it.pts, w, h, 12);
    return { it, P };
  });
  const hitSeg = (a, b, c, d) => {
    const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null;
  };
  const out = [];
  const add = (p, A, B) => {
    if (out.some((o) => Math.hypot(o.px - p.x, o.py - p.y) < 24)) return;
    out.push(makeNode("cross", p, w, h, { px: p.x, py: p.y, colors: [A.color, B.color], instrs: [A.instr, B.instr] }));
  };
  for (let a = 0; a < segs.length && out.length < 16; a++) {
    for (let b = a; b < segs.length && out.length < 16; b++) {
      const A = segs[a].P;
      const B = segs[b].P;
      for (let i = 1; i < A.length; i++) {
        for (let j = a === b ? i + 3 : 1; j < B.length; j++) {
          const p = hitSeg(A[i - 1], A[i], B[j - 1], B[j]);
          if (p) add(p, segs[a].it, segs[b].it);
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sound                                                               */
/* ------------------------------------------------------------------ */

function impulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

class Engine {
  constructor(getCtx) {
    this.getCtx = getCtx;
    this.ctx = null;
    this.voices = 0;
  }

  init() {
    if (this.ctx) return this.ctx;
    const ctx = this.getCtx();
    if (!ctx) return null;
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp).connect(ctx.destination);
    this.dry = ctx.createGain();
    this.dry.connect(this.master);

    // Dotted-eighth echo with a darkening feedback loop.
    this.delay = ctx.createDelay(2);
    const fb = ctx.createGain();
    const dark = ctx.createBiquadFilter();
    fb.gain.value = 0.33;
    dark.type = "lowpass";
    dark.frequency.value = 2600;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.2;
    this.delaySend.connect(this.delay);
    this.delay.connect(dark).connect(fb).connect(this.delay);
    dark.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx, 2.6, 2.4);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.32;
    this.revSend.connect(this.reverb).connect(this.master);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  setMuted(m) {
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.03);
  }

  setStep(stepDur) {
    if (this.delay) this.delay.delayTime.setTargetAtTime(stepDur * 3, this.ctx.currentTime, 0.05);
  }

  /** A panned output that feeds the dry mix and the echo / reverb sends. */
  bus(pan, echo = true, verb = true) {
    // Older Safari has no StereoPanner: fall back to a plain (centred) gain node.
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : this.ctx.createGain();
    if (p.pan) p.pan.value = clamp(pan, -1, 1);
    p.connect(this.dry);
    if (echo) p.connect(this.delaySend);
    if (verb) p.connect(this.revSend);
    return p;
  }

  track(node, stopAt) {
    this.voices++;
    node.onended = () => this.voices--;
    node.stop(stopAt);
  }

  /** 808-style bass drop: a sub sine that slides down onto the note and booms. */
  drop(midi, t, depth = 1, pan = 0) {
    if (!this.ctx || this.voices > 64) return;
    const ctx = this.ctx;
    while (midi > 45) midi -= 12;
    const f = hz(midi);
    const out = this.bus(pan * 0.4, false, true);
    const o = ctx.createOscillator();
    const sh = ctx.createWaveShaper();
    const g = ctx.createGain();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    sh.curve = curve;
    o.type = "sine";
    o.frequency.setValueAtTime(f * 2.6, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.09 + 0.12 * (1 - depth));
    const len = 0.7 + 0.5 * (1 - depth);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.006);
    g.gain.setTargetAtTime(0.3, t + 0.05, 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(sh).connect(g).connect(out);
    o.start(t);
    this.track(o, t + len + 0.05);
    this.drum("kick", t, 0.45 + 0.35 * depth, pan);
  }

  /** Crossing shimmer: a bright noise wash plus two high chimes. */
  shimmer(m1, m2, t, pan = 0) {
    if (!this.ctx || this.voices > 64) return;
    const ctx = this.ctx;
    const out = this.bus(pan, true, true);
    const src = ctx.createBufferSource();
    const hp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = this.noise;
    src.loop = true;
    hp.type = "highpass";
    hp.frequency.setValueAtTime(9000, t);
    hp.frequency.exponentialRampToValueAtTime(4200, t + 1.2);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    src.connect(hp).connect(g).connect(out);
    src.start(t);
    this.track(src, t + 1.45);
    while (m1 < 72) m1 += 12;
    while (m2 < 79) m2 += 12;
    this.note(m1, t, 0.2, "bell", pan - 0.3, 0.7);
    this.note(m2, t + 0.06, 0.2, "bell", pan + 0.3, 0.6);
  }

  note(midi, t, dur, instr, pan, vel = 1) {
    if (!this.ctx || this.voices > 64) return;
    const ctx = this.ctx;
    const out = this.bus(pan, instr !== "bass", true);
    const vca = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    vca.gain.value = 0;
    lp.connect(vca).connect(out);
    const srcs = [];
    const osc = (type, f, detune = 0, level = 1) => {
      const o = ctx.createOscillator();
      srcs.push(o);
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      g.gain.value = level;
      o.connect(g).connect(lp);
      o.start(t);
      return o;
    };
    const g = vca.gain;
    let f = hz(midi);
    let end;

    if (instr === "bell") {
      // FM bell: a bright strike that mellows as the modulator fades.
      const c = ctx.createOscillator();
      const m = ctx.createOscillator();
      const mg = ctx.createGain();
      c.frequency.value = f;
      m.frequency.value = f * 3.5;
      mg.gain.setValueAtTime(f * 2.4, t);
      mg.gain.exponentialRampToValueAtTime(f * 0.15, t + 0.9);
      m.connect(mg).connect(c.frequency);
      c.connect(lp);
      lp.frequency.value = 9000;
      const ring = Math.max(1.4, dur + 0.8);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(0.16 * vel, t + 0.003);
      g.exponentialRampToValueAtTime(0.0001, t + ring);
      end = t + ring + 0.05;
      m.start(t);
      c.start(t);
      m.stop(end);
      this.track(c, end);
      return;
    }

    let o;
    if (instr === "pluck") {
      o = osc("sawtooth", f, -6);
      osc("sawtooth", f, 6, 0.8);
      lp.Q.value = 4;
      lp.frequency.setValueAtTime(6000, t);
      lp.frequency.exponentialRampToValueAtTime(320, t + 0.35);
      const ring = Math.min(0.9, 0.35 + dur);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(0.12 * vel, t + 0.003);
      g.exponentialRampToValueAtTime(0.0001, t + ring);
      end = t + ring + 0.05;
    } else {
      let a, peak, sus, rel;
      if (instr === "bass") {
        if (midi >= 48) f /= 2;
        o = osc("sawtooth", f);
        osc("square", f / 2, 0, 0.5);
        lp.Q.value = 6;
        lp.frequency.setValueAtTime(1900, t);
        lp.frequency.exponentialRampToValueAtTime(480, t + 0.25);
        [a, peak, sus, rel] = [0.008, 0.22, 0.17, 0.12];
      } else if (instr === "lead") {
        o = osc("sawtooth", f, -8);
        const o2 = osc("sawtooth", f, 8);
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(14, t + 0.35);
        lfo.connect(depth);
        depth.connect(o.detune);
        depth.connect(o2.detune);
        lfo.start(t);
        lfo.stop(t + dur + 0.6);
        lp.Q.value = 2;
        lp.frequency.value = 2600;
        [a, peak, sus, rel] = [0.02, 0.1, 0.08, 0.25];
      } else if (instr === "stab") {
        // Chord stab for corners: bright detuned saw + square, quick filter snap.
        o = osc("sawtooth", f, -9);
        osc("square", f, 9, 0.55);
        osc("sine", f / 2, 0, 0.5);
        lp.Q.value = 5;
        lp.frequency.setValueAtTime(1200 + 5200 * vel, t);
        lp.frequency.exponentialRampToValueAtTime(380, t + 0.28);
        [a, peak, sus, rel] = [0.004, 0.13, 0.02, 0.25];
      } else if (instr === "pad") {
        o = osc("sawtooth", f, -12);
        osc("sawtooth", f, 0);
        osc("sawtooth", f, 12);
        lp.frequency.value = 1500;
        [a, peak, sus, rel] = [0.28, 0.075, 0.07, 1.0];
      } else {
        // Glass keys (the default, like the video): soft triangle + octave shimmer.
        o = osc("triangle", f);
        osc("sine", f * 2, 0, 0.28);
        osc("sawtooth", f, 5, 0.1);
        lp.Q.value = 1;
        lp.frequency.setValueAtTime(4200, t);
        lp.frequency.exponentialRampToValueAtTime(1300, t + 0.4);
        [a, peak, sus, rel] = [0.008, 0.2, 0.11, 0.4];
      }
      const hold = Math.max(t + a + 0.05, t + dur);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(peak * vel, t + a);
      g.setTargetAtTime(sus * vel, t + a, 0.12);
      g.setValueAtTime(sus * vel, hold);
      g.exponentialRampToValueAtTime(0.0001, hold + rel);
      end = hold + rel + 0.05;
    }
    for (const s of srcs) if (s !== o) s.stop(end);
    this.track(o, end);
  }

  drum(kind, t, vel = 1, pan = 0) {
    if (!this.ctx || this.voices > 72) return;
    const ctx = this.ctx;
    if (kind === "kick") {
      const out = this.bus(pan * 0.3, false, false);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(170, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      g.gain.setValueAtTime(0.95 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g).connect(out);
      o.start(t);
      this.track(o, t + 0.45);
      return;
    }
    const src = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = this.noise;
    src.connect(f).connect(g);
    if (kind === "hat") {
      g.connect(this.bus(pan, false, true));
      f.type = "highpass";
      f.frequency.value = 7500;
      g.gain.setValueAtTime(0.22 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      src.start(t);
      this.track(src, t + 0.08);
      return;
    }
    // snare: noise crack + a short tonal body
    const out = this.bus(pan, false, true);
    g.connect(out);
    f.type = "bandpass";
    f.frequency.value = 1900;
    f.Q.value = 0.8;
    g.gain.setValueAtTime(0.5 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.start(t);
    this.track(src, t + 0.25);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    og.gain.setValueAtTime(0.3 * vel, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og).connect(out);
    o.start(t);
    this.track(o, t + 0.14);
  }
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

export class MusicBoard {
  constructor(canvas, getCtx) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.engine = new Engine(getCtx);
    this.items = [];
    this.history = [];
    this.stroke = null;
    this.color = "#7cff6b";
    this.playing = false;
    this.beat = true;
    this.bpm = 100;
    this.anchorTime = 0;
    this.anchorStep = 0;
    this.nextStep = 0;
    this.pausedStep = 0;
    this.timer = 0;
    this.sparks = [];
    this.bursts = [];
    this.crosses = [];
    this.w = 1;
    this.h = 1;
  }

  get instrument() {
    return INSTRUMENTS[this.color] ?? INSTRUMENTS["#7cff6b"];
  }
  get stepDur() {
    return 60 / this.bpm / 4;
  }

  setColor(hex) {
    if (INSTRUMENTS[hex]) this.color = hex;
    return this.instrument.name;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dirty = true;
  }

  /* --- drawing --------------------------------------------------- */

  norm(p) {
    return { x: clamp(p.x / this.w, 0, 1), y: clamp(p.y / this.h, 0, 1) };
  }

  beginStroke(p) {
    this.stroke = { type: "line", pts: [this.norm(p)], color: this.color, instr: this.instrument.id, live: true, hitAt: -1 };
  }

  extendStroke(p) {
    const s = this.stroke;
    if (!s) return;
    const q = this.norm(p);
    const last = s.pts[s.pts.length - 1];
    if (Math.hypot((q.x - last.x) * this.w, (q.y - last.y) * this.h) >= 3) s.pts.push(q);
  }

  cancelStroke() {
    this.stroke = null;
  }

  /** Finishes the stroke: a tiny one becomes a drum ring, anything else a melody line. */
  endStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return null;
    const xs = s.pts.map((p) => p.x * this.w);
    const ys = s.pts.map((p) => p.y * this.h);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    let item;
    if (size < 26) {
      const x = xs.reduce((a, b) => a + b, 0) / xs.length / this.w;
      const y = ys.reduce((a, b) => a + b, 0) / ys.length / this.h;
      const kind = y < 0.42 ? "hat" : y < 0.68 ? "snare" : "kick";
      item = { type: "drum", x, y, kind, color: s.color, step: mod(Math.round(x * STEPS), STEPS), hitAt: -1 };
    } else {
      const pts = smooth(s.pts);
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      item = { type: "line", pts, color: s.color, instr: s.instr, pan: (cx - 0.5) * 0.8, trig: lineTriggers(pts), nodes: findNodes(pts, this.w, this.h), hitAt: -1 };
    }
    this.items.push(item);
    this.history.push({ op: "add", item });
    this.refreshCrosses();
    return item;
  }

  refreshCrosses() {
    this.dirty = true; // the drawing changed: redraw the stroke layer
    this.crosses = findCrosses(
      this.items.filter((i) => i.type === "line"),
      this.w,
      this.h,
    );
  }

  /** The special sound for a peak / valley / corner / crossing, plus its visual burst. */
  playNode(nd, t) {
    const e = this.engine;
    const sd = this.stepDur;
    const pan = (nd.x - 0.5) * 0.9;
    const at = (i) => NOTES[clamp(i, 0, NOTES.length - 1)];
    let label;
    if (nd.type === "peak") {
      // Sparkle arpeggio climbing from the peak's note. Sharper peak = more notes; the shape
      // of the run is picked from the peak's position, so every peak has its own phrase.
      const runs = [
        [0, 1, 2, 3, 4, 5, 6],
        [0, 2, 4, 5, 7, 9, 10],
        [0, 1, 2, 4, 2, 4, 5],
        [0, 2, 1, 3, 2, 5, 4],
      ];
      const run = runs[nd.seed % runs.length];
      const count = 3 + Math.min(4, Math.round(nd.sharp * 1.4));
      for (let k = 0; k < count; k++) e.note(at(nd.n + run[k]).midi, t + (k * sd) / 2, sd * 0.7, "bell", pan - 0.45 + (0.9 * k) / count, 0.55);
      label = `✦ ${at(nd.n).name}`;
    } else if (nd.type === "valley") {
      // Deep 808 drop: a sharp V hits hard and short, a round U slides and booms longer.
      e.drop(at(nd.n).midi, t, clamp(nd.sharp / 2, 0, 1), pan);
      label = `▼ ${at(nd.n).name.replace(/\d/, "")}`;
    } else if (nd.type === "corner") {
      // Chord stab strummed in the direction the line turned; sharper = brighter, adds a top note.
      // The chord shape is picked from the corner's position, so two corners at the same height still differ.
      const shapes = [
        [0, 2, 4],
        [0, 1, 3],
        [0, 2, 5],
        [0, 3, 4],
        [-1, 1, 3],
      ];
      const chord = shapes[nd.seed % shapes.length].map((o) => clamp(nd.n + o, 0, NOTES.length - 1));
      if (nd.sharp > 1.6) chord.push(clamp(nd.n + 5, 0, NOTES.length - 1));
      const order = nd.dir < 0 ? chord : [...chord].reverse();
      const bright = clamp(0.35 + nd.sharp / Math.PI, 0.4, 1);
      order.forEach((idx, k) => e.note(NOTES[idx].midi, t + k * 0.03, sd * 1.4, "stab", pan, bright));
      label = `◆ ${chord.map((i) => NOTES[i].name.replace(/\d/, "")).join(" ")}`;
    } else {
      e.shimmer(at(nd.n).midi, at(nd.n + 2).midi, t, pan);
      label = "✸";
    }
    nd.hitAt = t;
    this.bursts.push({ x: nd.x, y: nd.y, t, type: nd.type, label, seed: nd.seed });
    if (this.bursts.length > 60) this.bursts.shift();
  }

  label(item) {
    return item.type === "drum" ? DRUM_NAMES[item.kind] : INSTRUMENTS[item.color]?.name ?? "Melody";
  }

  itemAt(p, pad = 22) {
    let best = null;
    let bestD = pad;
    for (const it of this.items) {
      let dd;
      if (it.type === "drum") dd = Math.hypot(it.x * this.w - p.x, it.y * this.h - p.y) - 10;
      else {
        dd = Infinity;
        for (let i = 1; i < it.pts.length; i++) dd = Math.min(dd, this.segDist(p, it.pts[i - 1], it.pts[i]));
      }
      if (dd < bestD) {
        bestD = dd;
        best = it;
      }
    }
    return best;
  }

  segDist(p, a, b) {
    const ax = a.x * this.w;
    const ay = a.y * this.h;
    const bx = b.x * this.w;
    const by = b.y * this.h;
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = l2 ? clamp(((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / l2, 0, 1) : 0;
    return Math.hypot(p.x - (ax + t * (bx - ax)), p.y - (ay + t * (by - ay)));
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.history.push({ op: "remove", item, index: i });
    this.refreshCrosses();
    return true;
  }

  undo() {
    const h = this.history.pop();
    if (!h) return false;
    if (h.op === "add") this.items.splice(this.items.indexOf(h.item), 1);
    else if (h.op === "remove") this.items.splice(h.index, 0, h.item);
    else if (h.op === "clear") this.items = h.items;
    this.refreshCrosses();
    return true;
  }

  clear() {
    if (!this.items.length) return false;
    this.history.push({ op: "clear", items: this.items });
    this.items = [];
    this.crosses = [];
    this.dirty = true;
    return true;
  }

  /* --- transport ------------------------------------------------- */

  /** The music clock: the audio clock when there's sound, otherwise the page clock (visuals still run). */
  now() {
    const c = this.engine.ctx;
    return c ? c.currentTime : performance.now() / 1000;
  }

  stepPos(t) {
    return this.anchorStep + (t - this.anchorTime) / this.stepDur;
  }

  /** Playhead position, 0 … 1 across the screen, in sync with what you hear. */
  phase() {
    if (!this.playing) return mod(this.pausedStep, STEPS) / STEPS;
    const c = this.engine.ctx;
    const t = this.now() - (c?.outputLatency || c?.baseLatency || 0);
    return mod(this.stepPos(t), STEPS) / STEPS;
  }

  play() {
    if (this.playing) return true;
    const ctx = this.engine.init(); // null if the browser has no Web Audio: the playhead still runs
    ctx?.resume?.();
    this.engine.setStep(this.stepDur);
    this.anchorStep = Math.ceil(this.pausedStep);
    this.anchorTime = this.now() + 0.06;
    this.nextStep = this.anchorStep;
    this.playing = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), 25);
    return true;
  }

  pause() {
    if (!this.playing) return;
    this.pausedStep = this.stepPos(this.now());
    this.playing = false;
    clearInterval(this.timer);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
    return this.playing;
  }

  setBpm(bpm) {
    if (this.playing) {
      const t = this.now();
      this.anchorStep = this.stepPos(t);
      this.anchorTime = t;
    }
    this.bpm = bpm;
    this.engine.setStep(this.stepDur);
  }

  cycleTempo() {
    this.setBpm(TEMPOS[(TEMPOS.indexOf(this.bpm) + 1) % TEMPOS.length]);
    return this.bpm;
  }

  setMuted(m) {
    this.engine.setMuted(m);
  }

  schedule() {
    if (!this.playing) return;
    const t = this.now();
    const timeOf = (n) => this.anchorTime + (n - this.anchorStep) * this.stepDur;
    if (timeOf(this.nextStep) < t - 0.1) this.nextStep = Math.ceil(this.stepPos(t)); // tab was asleep: skip ahead
    while (timeOf(this.nextStep) < t + 0.12) {
      this.playStep(mod(this.nextStep, STEPS), timeOf(this.nextStep));
      this.nextStep++;
    }
  }

  playStep(st, t) {
    const e = this.engine;
    const sd = this.stepDur;
    const lines = this.stroke && this.stroke.pts.length > 1 ? [...this.items, this.stroke] : this.items;
    for (const it of lines) {
      if (it.type === "drum") {
        if (it.step === st) {
          e.drum(it.kind, t, 0.9, (it.x - 0.5) * 0.8);
          it.hitAt = t;
          this.sparks.push({ x: it.x, y: it.y, t, color: PLAYHEAD });
        }
        continue;
      }
      if (it.live && it.trigLen !== it.pts.length) {
        it.trig = lineTriggers(it.pts);
        it.trigLen = it.pts.length;
        const cx = it.pts.reduce((a, p) => a + p.x, 0) / it.pts.length;
        it.pan = (cx - 0.5) * 0.8;
      }
      if (it.live && it.nodesLen !== it.pts.length && it.pts.length > 4) {
        it.nodes = findNodes(it.pts, this.w, this.h);
        it.nodesLen = it.pts.length;
      }
      for (const nd of it.nodes ?? []) if (nd.step === st) this.playNode(nd, t);
      const hits = it.trig[st];
      if (!hits.length) continue;
      const vel = hits.length > 1 ? 0.75 : 1;
      hits.forEach((h, k) => {
        e.note(NOTES[h.n].midi, t + k * 0.02, h.len * sd * 0.98, it.instr, it.pan, vel);
        this.sparks.push({ x: st / STEPS, y: noteY(h.n), t: t + k * 0.02, color: it.color });
      });
      it.hitAt = t;
    }
    for (const nd of this.crosses) if (nd.step === st) this.playNode(nd, t);
    // A soft backing beat once something is on the board.
    if (this.beat && this.items.length) {
      const s = st % 16;
      if (s === 0 || s === 10) e.drum("kick", t, 0.6);
      if (s === 4 || s === 12) e.drum("snare", t, 0.32);
      if (s % 2 === 0) e.drum("hat", t, s % 4 === 0 ? 0.35 : 0.2, 0.25);
    }
    if (this.sparks.length > 120) this.sparks.splice(0, this.sparks.length - 120);
  }

  /* --- rendering ------------------------------------------------- */

  path(pts) {
    const c = this.ctx;
    const P = pts.map((p) => ({ x: p.x * this.w, y: p.y * this.h }));
    c.beginPath();
    c.moveTo(P[0].x, P[0].y);
    if (P.length < 3) {
      for (const p of P.slice(1)) c.lineTo(p.x, p.y);
      return;
    }
    for (let i = 1; i < P.length - 1; i++) {
      const mx = (P[i].x + P[i + 1].x) / 2;
      const my = (P[i].y + P[i + 1].y) / 2;
      c.quadraticCurveTo(P[i].x, P[i].y, mx, my);
    }
    c.lineTo(P[P.length - 1].x, P[P.length - 1].y);
  }

  /** A glossy, glowing 3D tube along the points (like the lime strokes in the video). */
  tube(build, color, w, glow = 18) {
    const c = this.ctx;
    const pass = (style, width, dx = 0, dy = 0, blur = 0, glowColor = color) => {
      c.save();
      c.translate(dx, dy);
      c.strokeStyle = style;
      c.lineWidth = width;
      c.shadowBlur = blur;
      c.shadowColor = glowColor;
      build();
      c.stroke();
      c.restore();
    };
    c.lineCap = "round";
    c.lineJoin = "round";
    // Drop shadow → dark rim with glow → body → lit upper half → hard specular streak.
    pass("rgba(0, 0, 0, 0.4)", w + 4, 3, 5);
    pass(mix(color, "#000000", 0.6), w + 4, 0, 0, glow);
    pass(mix(color, "#000000", 0.2), w);
    pass(color, w * 0.72, -w * 0.06, -w * 0.1);
    pass(mix(color, "#ffffff", 0.5), w * 0.38, -w * 0.12, -w * 0.2);
    pass("rgba(255, 255, 255, 0.95)", Math.max(1.5, w * 0.14), -w * 0.16, -w * 0.27);
  }

  ring(it, scale = 1) {
    const r = (it.kind === "kick" ? 18 : it.kind === "snare" ? 14 : 11) * scale;
    const x = it.x * this.w;
    const y = it.y * this.h;
    this.tube(
      () => {
        this.ctx.beginPath();
        this.ctx.ellipse(x, y, r, r * 0.62, 0, 0, Math.PI * 2);
      },
      it.color,
      8,
    );
  }

  grid(px) {
    const c = this.ctx;
    const W = this.w;
    const H = this.h;
    c.save();
    c.font = "600 10px ui-sans-serif, system-ui, sans-serif";
    c.textBaseline = "middle";
    NOTES.forEach((n, i) => {
      const y = noteY(i) * H;
      c.strokeStyle = n.root ? "rgba(255, 255, 255, 0.16)" : "rgba(255, 255, 255, 0.05)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(38, y);
      c.lineTo(W, y);
      c.stroke();
      const near = Math.abs(px - 22) < 40;
      c.fillStyle = n.root ? "rgba(255, 255, 255, 0.75)" : near ? "rgba(255, 210, 250, 0.7)" : "rgba(255, 255, 255, 0.42)";
      c.fillText(n.name, 8, y);
    });
    for (let b = 0; b <= 8; b++) {
      const x = (b / 8) * W;
      c.strokeStyle = b % 4 === 0 ? "rgba(255, 255, 255, 0.1)" : "rgba(255, 255, 255, 0.035)";
      c.beginPath();
      c.moveTo(x, TOP * H);
      c.lineTo(x, BOTTOM * H);
      c.stroke();
    }
    c.restore();
  }

  drawItem(it, tubeW, pulse) {
    if (it.type === "drum") this.ring(it, 1 + pulse * 0.35);
    else if (it.pts.length > 1) this.tube(() => this.path(it.pts), it.color, tubeW, 16 + pulse * 18);
    else {
      const c = this.ctx;
      c.fillStyle = it.color;
      c.beginPath();
      c.arc(it.pts[0].x * this.w, it.pts[0].y * this.h, tubeW / 2, 0, Math.PI * 2);
      c.fill();
    }
  }

  /**
   * Draws every finished stroke once into an offscreen layer. The glossy glow is the
   * costliest part to draw (especially on Retina Macs), so it's only redone when the
   * drawing changes, not 60 times a second.
   */
  bakeLayer(tubeW) {
    this.layer ??= document.createElement("canvas");
    const L = this.layer;
    if (L.width !== this.canvas.width || L.height !== this.canvas.height) {
      L.width = this.canvas.width;
      L.height = this.canvas.height;
    }
    const lc = L.getContext("2d");
    const dpr = this.canvas.width / this.w;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, L.width, L.height);
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    const main = this.ctx;
    this.ctx = lc;
    try {
      for (const it of this.items) this.drawItem(it, tubeW, 0);
    } finally {
      this.ctx = main;
    }
    this.layerTube = tubeW;
    this.dirty = false;
  }

  render(_now, { hover = null, erase = null } = {}) {
    const c = this.ctx;
    const dpr = this.canvas.width / this.w;
    const W = this.w;
    const H = this.h;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    const t = this.now() - (this.engine.ctx?.outputLatency || 0);
    const ph = this.phase();
    const px = ph * W;
    const tubeW = clamp(Math.min(W, H) / 52, 9, 17);
    this.grid(px);

    const all = this.stroke ? [...this.items, this.stroke] : this.items;
    const lineOf = (it) => () => this.path(it.pts);

    // Finished strokes come from the pre-drawn layer; only the live stroke and pulses are drawn per frame.
    if (this.dirty || this.layerTube !== tubeW) this.bakeLayer(tubeW);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.layer, 0, 0);
    c.restore();
    for (const it of all) {
      const pulse = this.playing && it.hitAt >= 0 && t >= it.hitAt ? Math.exp(-(t - it.hitAt) / 0.12) : 0;
      if (it === this.stroke) this.drawItem(it, tubeW, 0);
      else if (it.type === "drum" && pulse > 0.05) this.ring(it, 1 + pulse * 0.35);
      if (it === hover || it === erase) {
        c.save();
        c.strokeStyle = it === erase ? "rgba(255, 77, 94, 0.9)" : "rgba(255, 255, 255, 0.8)";
        c.setLineDash([6, 6]);
        c.lineWidth = 2;
        if (it.type === "drum") {
          c.beginPath();
          c.arc(it.x * W, it.y * H, 24, 0, Math.PI * 2);
        } else this.path(it.pts);
        c.stroke();
        c.restore();
      }
    }

    // Node markers: the special points of each drawing, each with its own symbol.
    const nodes = [...all.flatMap((it) => (it.type === "line" ? (it.nodes ?? []) : [])), ...this.crosses];
    for (const nd of nodes) {
      const pulse = this.playing && nd.hitAt >= 0 && t >= nd.hitAt ? Math.exp(-(t - nd.hitAt) / 0.18) : 0;
      this.marker(nd, nd.x * W, nd.y * H, 1 + pulse * 0.9, pulse);
    }

    // Where the playhead touches a line, the line glows hot pink-white.
    c.save();
    c.beginPath();
    c.rect(px - 26, 0, 52, H);
    c.clip();
    for (const it of all) {
      if (it.type !== "line" || it.pts.length < 2) continue;
      c.globalAlpha = 0.85;
      this.tube(lineOf(it), "#ffc4f4", tubeW * 0.9, 24);
    }
    c.restore();

    // Fading comet trail behind the playhead.
    const trail = c.createLinearGradient(px - 90, 0, px, 0);
    trail.addColorStop(0, "rgba(255, 47, 214, 0)");
    trail.addColorStop(1, "rgba(255, 47, 214, 0.12)");
    c.fillStyle = trail;
    c.fillRect(px - 90, 0, 90, H);

    // The playhead.
    c.save();
    c.strokeStyle = PLAYHEAD;
    c.shadowColor = PLAYHEAD;
    c.shadowBlur = 22;
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(px, 0);
    c.lineTo(px, H);
    c.stroke();
    c.lineWidth = 1;
    c.strokeStyle = "rgba(255, 230, 250, 0.9)";
    c.shadowBlur = 0;
    c.stroke();
    c.restore();

    // Orbs where the playhead crosses each line.
    for (const it of all) {
      if (it.type !== "line" || it.pts.length < 2) continue;
      const pulse = this.playing && it.hitAt >= 0 && t >= it.hitAt ? Math.exp(-(t - it.hitAt) / 0.14) : 0;
      for (let i = 1; i < it.pts.length; i++) {
        const a = it.pts[i - 1];
        const b = it.pts[i];
        if ((a.x - ph) * (b.x - ph) > 0 || a.x === b.x) continue;
        const y = (a.y + ((ph - a.x) / (b.x - a.x)) * (b.y - a.y)) * H;
        this.orb(px, y, 1 + pulse * 0.6);
      }
    }

    // Sparks: a ring at the snapped note each time something plays.
    c.save();
    this.sparks = this.sparks.filter((s) => t - s.t < 0.6);
    for (const s of this.sparks) {
      if (t < s.t) continue;
      const k = (t - s.t) / 0.6;
      c.globalAlpha = (1 - k) * 0.9;
      c.strokeStyle = mix(s.color, "#ffffff", 0.4);
      c.shadowColor = s.color;
      c.shadowBlur = 12;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(s.x * W, s.y * H, 6 + k * 26, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
    this.drawBursts(t);
  }

  /** A star with `n` points (inner radius = r * inner). */
  star(x, y, r, n, inner, rot = -Math.PI / 2) {
    const c = this.ctx;
    c.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const rr = i % 2 ? r * inner : r;
      const a = rot + (i * Math.PI) / n;
      c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    c.closePath();
  }

  marker(nd, x, y, scale, glow) {
    const c = this.ctx;
    const col = NODE_COLORS[nd.type];
    c.save();
    c.shadowColor = col;
    c.shadowBlur = 10 + glow * 30;
    c.fillStyle = mix(col, "#ffffff", 0.35 + glow * 0.5);
    c.strokeStyle = col;
    c.lineWidth = 2;
    if (nd.type === "peak") {
      this.star(x, y, 8 * scale, 4, 0.35);
      c.fill();
    } else if (nd.type === "valley") {
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(x, y, 7 * scale, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(x, y, 2.5 * scale, 0, Math.PI * 2);
      c.fill();
    } else if (nd.type === "corner") {
      this.star(x, y, 7 * scale, 2, 0.75, 0);
      c.fill();
    } else {
      this.star(x, y, 10 * scale, 6, 0.3, (nd.seed % 10) / 10);
      c.fill();
    }
    c.restore();
  }

  /** Shockwave, flying particles and a floating label when a node plays. */
  drawBursts(t) {
    const c = this.ctx;
    const W = this.w;
    const H = this.h;
    const LIFE = 1.0;
    this.bursts = this.bursts.filter((b) => t - b.t < LIFE);
    c.save();
    for (const b of this.bursts) {
      if (t < b.t) continue;
      const k = (t - b.t) / LIFE;
      const fade = 1 - k;
      const col = NODE_COLORS[b.type];
      const x = b.x * W;
      const y = b.y * H;
      c.globalAlpha = fade;
      c.shadowColor = col;
      c.shadowBlur = 16;
      c.strokeStyle = col;
      c.lineWidth = 3 * fade + 0.5;
      c.beginPath();
      if (b.type === "valley") c.ellipse(x, y, 10 + k * 110, 4 + k * 22, 0, 0, Math.PI * 2); // ground shake
      else c.arc(x, y, 8 + k * (b.type === "cross" ? 90 : 60), 0, Math.PI * 2);
      c.stroke();

      // Particles: peaks shoot upward, valleys spray sideways, corners and crosses burst all round.
      c.fillStyle = mix(col, "#ffffff", 0.4);
      const count = b.type === "cross" ? 16 : 11;
      for (let i = 0; i < count; i++) {
        const r = ((b.seed >> (i % 16)) & 7) / 7;
        let a = (i / count) * Math.PI * 2 + (b.seed % 100) / 50;
        if (b.type === "peak") a = -Math.PI / 2 + (i / (count - 1) - 0.5) * 1.6;
        const dist = (35 + r * 55) * Math.sqrt(k);
        const px = x + Math.cos(a) * dist * (b.type === "valley" ? 1.8 : 1);
        const py = y + Math.sin(a) * dist * (b.type === "valley" ? 0.35 : 1) + (b.type === "peak" ? 0 : k * k * 30);
        c.beginPath();
        c.arc(px, py, (2 + r * 2.5) * fade, 0, Math.PI * 2);
        c.fill();
      }

      if (b.label) {
        c.shadowBlur = 8;
        c.fillStyle = "#ffffff";
        c.font = "700 14px ui-sans-serif, system-ui, 'Segoe UI Symbol', sans-serif";
        c.textAlign = "center";
        c.fillText(b.label, x, y - 26 - k * 34);
      }
    }
    c.restore();
  }

  orb(x, y, scale) {
    const c = this.ctx;
    const r = 28 * scale;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255, 255, 255, 1)");
    g.addColorStop(0.22, "rgba(255, 140, 240, 0.95)");
    g.addColorStop(0.5, "rgba(255, 47, 214, 0.55)");
    g.addColorStop(1, "rgba(255, 47, 214, 0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(255, 255, 255, 0.85)";
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(x, y, 5.5, 0, Math.PI * 2);
    c.stroke();
  }

  /** Small summary for the debug API / tests. */
  summary() {
    return {
      playing: this.playing,
      bpm: this.bpm,
      beat: this.beat,
      instrument: this.instrument.name,
      items: this.items.map((i) => (i.type === "drum" ? i.kind : i.instr)),
      nodes: [...this.items.flatMap((i) => i.nodes ?? []), ...this.crosses].map((n) => n.type),
      phase: Number(this.phase().toFixed(3)),
    };
  }
}
