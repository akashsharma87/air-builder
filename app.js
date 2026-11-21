// Air Builder: stack Lego-style bricks and sketch diagrams with hand gestures.
// MediaPipe finds 21 points on your hand in each webcam frame (in the browser);
// gestures.js turns them into a cursor + pose; build.js and draw.js do the rest.
import { BrickWorld } from "./build.js?v=5";
import { DrawBoard } from "./draw.js?v=5";
import { MusicBoard } from "./music.js?v=5";
import { HAND_CONNECTIONS, OneEuro, PinchLatch, PoseStabilizer, classifyPose, clamp, readHand } from "./gestures.js?v=5";

const MEDIAPIPE_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const REACH = 0.12; // ignore this much of each camera edge, so the whole screen is easy to reach

const $ = (id) => document.getElementById(id);
const body = document.body;
const overlay = $("overlay");
const octx = overlay.getContext("2d");
const video = $("camera");
const statusEl = $("status");
const toastEl = $("toast");
const binEl = $("bin");
const hintsEl = $("hints");
const startEl = $("start");
const startBtn = $("startBtn");
const startMsg = $("startMsg");
const buttons = [...document.querySelectorAll("#toolbar button")];

const world = new BrickWorld($("world"));
const board = new DrawBoard($("board"));
const music = new MusicBoard($("music"), getAudio);

const LABELS = { rect: "Rectangle", ellipse: "Circle", triangle: "Triangle", arrow: "Arrow", link: "Connected", path: "Sketch" };
const HINTS = {
  build: [
    ["Point", "to aim"],
    ["Pinch", "to place a brick"],
    ["Pinch + drag", "to build a wall"],
    ["Fist", "to break bricks"],
    ["Open palm", "to rotate the view"],
  ],
  draw: [
    ["Point", "to draw"],
    ["Open palm", "to lift the pen"],
    ["Pinch", "to move a shape"],
    ["Line between shapes", "connects them"],
    ["Fist", "to erase"],
  ],
  music: [
    ["Pinch + move", "to draw a melody"],
    ["Pinch tap", "for a drum hit"],
    ["Higher", "= higher note"],
    ["Colour", "= instrument"],
    ["Fist", "to erase"],
  ],
};
const MODE_NAMES = { build: "Build", draw: "Draw", music: "Music" };

const state = {
  mode: "build", // switched to "music" at startup, below
  source: "idle", // idle | camera | mouse
  color: "#00e5ff",
  hand: null,
  pose: "none",
  pinching: false,
  poseSince: 0,
  cursor: null,
  tipOffset: { x: 0, y: -0.12 },
  lastPalm: null,
  handSeenAt: -Infinity,
  hoverButton: null,
  pinchConsumed: false,
  hoverItem: null,
  eraseTarget: null,
  eraseStart: 0,
  lastEraseAt: 0,
  action: "",
  mouse: null,
  modelError: false,
  sound: true,
};

const pinchLatch = new PinchLatch();
const stabilizer = new PoseStabilizer(2);
const fx = new OneEuro(1.2, 0.005);
const fy = new OneEuro(1.2, 0.005);
let landmarker = null;
let audio = null;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function getAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    // no audio: fine
  }
  return audio;
}

function toScreen(p, clampIt = true) {
  const f = (v) => (v - REACH) / (1 - 2 * REACH);
  const x = clampIt ? clamp(f(p.x), 0, 1) : f(p.x);
  const y = clampIt ? clamp(f(p.y), 0, 1) : f(p.y);
  return { x: x * window.innerWidth, y: y * window.innerHeight };
}

let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 800);
}

function tick(freq = 600) {
  if (!state.sound) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.09);
  } catch {
    // no audio: fine
  }
}

function overBin(p) {
  const r = binEl.getBoundingClientRect();
  return p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

function showBin(on, hot = false) {
  binEl.classList.toggle("show", on);
  binEl.classList.toggle("hot", on && hot);
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

function setMode(mode, announce = true) {
  if (board.stroke) board.endStroke();
  if (board.moving) board.endMove(false);
  if (music.stroke) music.endStroke();
  world.endSession();
  world.hideGhost();
  showBin(false);
  state.mode = mode;
  state.hoverItem = state.eraseTarget = null;
  body.classList.toggle("mode-build", mode === "build");
  body.classList.toggle("mode-draw", mode === "draw");
  body.classList.toggle("mode-music", mode === "music");
  for (const b of buttons) if (b.dataset.mode) b.classList.toggle("on", b.dataset.mode === mode);
  hintsEl.innerHTML = HINTS[mode].map(([g, t]) => `<span><b>${g}</b> ${t}</span>`).join("");
  // The playhead runs only in Music mode (it starts by itself when you enter).
  if (mode === "music" && state.source !== "idle") music.play();
  else if (mode !== "music") music.pause();
  refreshMusicButtons();
  refreshSwatches();
  if (announce) toast(`${MODE_NAMES[mode]} mode`);
}

/** Colour swatches show this mode's colour (in Music mode the colour is the instrument). */
function refreshSwatches() {
  const hex = state.mode === "music" ? music.color : state.color;
  for (const b of buttons) if (b.dataset.color) b.classList.toggle("on", b.dataset.color === hex);
}

function refreshMusicButtons() {
  for (const b of buttons) {
    if (b.dataset.action === "play") b.textContent = music.playing ? "Pause" : "Play";
    else if (b.dataset.action === "beat") b.classList.toggle("on", music.beat);
    else if (b.dataset.action === "tempo") b.textContent = `${music.bpm} BPM`;
  }
}

function togglePlay() {
  if (state.mode !== "music") setMode("music");
  else toast(music.toggle() ? "Play" : "Pause");
  refreshMusicButtons();
}

function setColor(hex) {
  if (state.mode === "music") {
    toast(music.setColor(hex));
    refreshSwatches();
    return;
  }
  state.color = hex;
  board.color = hex;
  world.setColor(hex);
  for (const b of buttons) if (b.dataset.color) b.classList.toggle("on", b.dataset.color === hex);
}

function current() {
  return state.mode === "draw" ? board : state.mode === "music" ? music : world;
}

function undo() {
  if (current().undo()) {
    toast("Undo");
    tick(420);
  }
}

function clearAll() {
  if (current().clear()) {
    toast("Cleared");
    tick(260);
  }
}

function setAR(on) {
  if (on && state.source !== "camera") {
    toast("AR needs the camera");
    return;
  }
  state.ar = on;
  body.classList.toggle("ar", on);
  world.setAR(on);
  for (const b of buttons) if (b.dataset.action === "ar") b.classList.toggle("on", on);
}

function smash() {
  if (state.mode !== "build") setMode("build", false);
  if (world.smash()) {
    toast("BOOM!");
    boom();
  }
}

function make3D() {
  const cells = board.toCells();
  if (!cells.length) {
    toast("Draw something first");
    return;
  }
  setMode("build", false);
  const top = Math.max(...cells.map((c) => c.j)) + 1;
  world.resetView(0.45, 0.3, top / 2, 18 + top); // face the wall it builds
  world.buildCells(cells);
  toast("Sketch → Lego");
  [0, 120, 240, 360].forEach((d, n) => setTimeout(() => tick(520 + n * 120), d));
}

/** A short noise burst for Smash. */
function boom() {
  if (!state.sound) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const len = Math.floor(audio.sampleRate * 0.5);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = audio.createBufferSource();
    const filter = audio.createBiquadFilter();
    const gain = audio.createGain();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    gain.gain.value = 0.5;
    src.buffer = buf;
    src.connect(filter).connect(gain).connect(audio.destination);
    src.start();
  } catch {
    // no audio: fine
  }
}

for (const b of buttons) {
  b.addEventListener("click", () => {
    if (b.dataset.mode) setMode(b.dataset.mode);
    else if (b.dataset.color) setColor(b.dataset.color);
    else if (b.dataset.action === "undo") undo();
    else if (b.dataset.action === "clear") clearAll();
    else if (b.dataset.action === "ar") setAR(!state.ar);
    else if (b.dataset.action === "smash") smash();
    else if (b.dataset.action === "make3d") make3D();
    else if (b.dataset.action === "play") togglePlay();
    else if (b.dataset.action === "beat") {
      music.beat = !music.beat;
      toast(music.beat ? "Beat on" : "Beat off");
      refreshMusicButtons();
    } else if (b.dataset.action === "tempo") {
      toast(`${music.cycleTempo()} BPM`);
      refreshMusicButtons();
    }
  });
}

function buttonAt(p) {
  if (!p || body.classList.contains("no-ui")) return null;
  for (const b of buttons) {
    const r = b.getBoundingClientRect();
    if (!r.width) continue; // hidden (e.g. a button for the other mode)
    if (p.x >= r.left - 6 && p.x <= r.right + 6 && p.y >= r.top - 6 && p.y <= r.bottom + 6) return b;
  }
  return null;
}

function setHoverButton(b) {
  if (state.hoverButton === b) return;
  state.hoverButton?.classList.remove("hover");
  state.hoverButton = b;
  b?.classList.add("hover");
}

function pressButton(b) {
  b.classList.add("press");
  setTimeout(() => b.classList.remove("press"), 160);
  tick(760);
  b.click();
}

/* ------------------------------------------------------------------ */
/* Hand → actions                                                      */
/* ------------------------------------------------------------------ */

function onHand(lm, now, w, h) {
  const r = readHand(lm, w, h);
  const pinching = pinchLatch.update(r);
  const pose = stabilizer.update(classifyPose(r, pinching));

  // The cursor follows the fingertip only while the index finger is really out.
  // Curled (fist, or mid-way into one) it follows the knuckle plus the last tip offset,
  // so closing your hand doesn't make the cursor jump.
  let anchor;
  if (pinching || r.ext[0] > 1.45) {
    anchor = pinching ? r.pinchPoint : r.tip;
    state.tipOffset = { x: anchor.x - r.knuckle.x, y: anchor.y - r.knuckle.y };
  } else anchor = { x: r.knuckle.x + state.tipOffset.x, y: r.knuckle.y + state.tipOffset.y };
  const raw = toScreen(anchor);
  const cursor = { x: fx.filter(raw.x, now / 1000), y: fy.filter(raw.y, now / 1000) };

  const prevPose = state.pose;
  const prevPinch = state.pinching;
  state.hand = lm;
  state.handSeenAt = now;
  state.cursor = cursor;
  state.pose = pose;
  state.pinching = pinching;
  if (pose !== prevPose) state.poseSince = now;

  handleInput({ cursor, pose, prevPose, pinchStart: pinching && !prevPinch, pinchEnd: !pinching && prevPinch, palm: r.palmCenter, now });
  state.lastPalm = r.palmCenter;
}

function onNoHand(now) {
  if (!state.hand || now - state.handSeenAt < 300) return;
  state.hand = null;
  state.cursor = null;
  state.pose = "none";
  state.pinching = false;
  state.pinchConsumed = false;
  state.hoverItem = state.eraseTarget = null;
  state.lastPalm = null;
  pinchLatch.reset();
  stabilizer.reset();
  fx.reset();
  fy.reset();
  if (board.stroke) board.endStroke();
  if (board.moving) board.endMove(false);
  if (music.stroke) music.endStroke();
  showBin(false);
  world.endSession();
  world.hideGhost();
  setHoverButton(null);
}

function handleInput(ev) {
  const { cursor, pinchStart, pinchEnd } = ev;
  const btn = buttonAt(cursor);
  setHoverButton(btn);
  state.action = "";

  if (pinchStart && btn) {
    pressButton(btn);
    state.pinchConsumed = true;
  }
  if (state.pinchConsumed) {
    state.action = "Pressing";
    if (pinchEnd) state.pinchConsumed = false;
    world.hideGhost();
    return;
  }
  if (state.mode === "draw") drawInput(ev, Boolean(btn));
  else if (state.mode === "music") musicInput(ev, Boolean(btn));
  else buildInput(ev, Boolean(btn));
}

function musicInput({ cursor, pose, pinchStart, now }, overUI) {
  // Pinch = pen down (like the video). Letting go finishes the line; a tiny pinch = drum ring.
  // A short grace period means a one-frame pinch flicker doesn't split the line in two.
  if (state.pinching) {
    state.penUpAt = null;
    if (music.stroke) music.extendStroke(cursor);
    else if (pinchStart && !overUI) music.beginStroke(cursor);
    if (music.stroke) state.action = "Drawing";
  } else if (music.stroke) {
    state.penUpAt ??= now;
    if (now - state.penUpAt > 110) {
      state.penUpAt = null;
      const item = music.endStroke();
      if (item) toast(music.label(item));
    }
  }

  // Fist held on a line or drum = erase it.
  state.hoverItem = !state.pinching && !music.stroke ? music.itemAt(cursor) : null;
  if (pose === "fist" && state.hoverItem) {
    if (state.eraseTarget !== state.hoverItem) {
      state.eraseTarget = state.hoverItem;
      state.eraseStart = now;
    }
    state.action = "Erasing";
    if (now - state.eraseStart > 450) {
      music.remove(state.eraseTarget);
      tick(240);
      state.eraseTarget = state.hoverItem = null;
    }
  } else state.eraseTarget = null;
  if (!state.action && pose === "point") state.action = "Aiming";
}

function drawInput({ cursor, pose, pinchStart, pinchEnd, now }, overUI) {
  // Point = pen down. Lifting the finger (open palm etc.) snaps the stroke into a shape.
  // A stroke that turns into a pinch or fist was just aiming, so it's thrown away.
  if (pose === "point" && !board.moving) {
    state.penUpAt = null;
    if (board.stroke) board.extendStroke(cursor);
    else if (!overUI) board.beginStroke(cursor);
    if (board.stroke) state.action = "Drawing";
  } else if (board.stroke) {
    if (pose === "pinch" || pose === "fist") {
      board.cancelStroke();
      state.penUpAt = null;
    } else {
      state.penUpAt ??= now;
      if (now - state.penUpAt > 120) {
        state.penUpAt = null;
        if (overUI) board.cancelStroke();
        else {
          const item = board.endStroke();
          if (item) {
            toast(LABELS[item.type]);
            tick(item.type === "link" ? 880 : 660);
          }
        }
      }
    }
  }

  // Pinch = grab and move a shape; drop it on the bin to delete.
  if (pinchStart && board.startMove(board.itemAt(cursor), cursor)) tick(520);
  if (board.moving) {
    if (state.pinching) {
      board.moveTo(cursor);
      showBin(true, overBin(cursor));
      state.action = "Moving";
    }
    if (pinchEnd) {
      if (board.endMove(overBin(cursor))) {
        toast("Deleted");
        tick(220);
      }
      showBin(false);
    }
  }

  // Fist held on an item = erase it.
  state.hoverItem = pose !== "point" && !board.moving ? board.itemAt(cursor) : null;
  if (pose === "fist" && state.hoverItem) {
    if (state.eraseTarget !== state.hoverItem) {
      state.eraseTarget = state.hoverItem;
      state.eraseStart = now;
    }
    state.action = "Erasing";
    if (now - state.eraseStart > 450) {
      board.remove(state.eraseTarget);
      tick(240);
      state.eraseTarget = state.hoverItem = null;
    }
  } else state.eraseTarget = null;
}

function buildInput({ cursor, pose, prevPose, pinchStart, pinchEnd, palm, now }, overUI) {
  if (pose === "open") {
    world.hideGhost();
    if (world.session) world.endSession();
    if (prevPose === "open" && state.lastPalm) world.orbit(palm.x - state.lastPalm.x, palm.y - state.lastPalm.y);
    state.action = "Rotating";
    return;
  }
  if (overUI && !world.session) {
    world.hideGhost();
    return;
  }

  world.aim(cursor.x, cursor.y, pose === "fist" ? "erase" : "place");

  if (pose === "pinch") {
    if (pinchStart) {
      world.beginSession("add");
      if (world.place()) tick(600);
      state.pinchOrigin = { ...cursor };
      state.painting = false;
    } else if (world.session?.type === "add") {
      // Start laying a wall only once the hand has really moved, so a still pinch = one brick.
      if (!state.painting && state.pinchOrigin && Math.hypot(cursor.x - state.pinchOrigin.x, cursor.y - state.pinchOrigin.y) > 24) state.painting = true;
      if (state.painting && world.place()) tick(680);
    }
    state.action = "Placing";
  }
  if (pinchEnd && world.session?.type === "add") world.endSession();

  if (pose === "fist") {
    if (!world.session) world.beginSession("remove");
    state.action = "Breaking";
    if (now - state.poseSince > 300 && now - state.lastEraseAt > 180 && world.removeHovered()) {
      state.lastEraseAt = now;
      tick(300);
    }
  } else if (world.session?.type === "remove") world.endSession();

  if (pose === "point") state.action = "Aiming";
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

let mp = null; // { HandLandmarker, vision } once loaded

async function reloadOnCPU() {
  if (!mp) return;
  try {
    landmarker = await createLandmarker(mp.HandLandmarker, mp.vision, ["CPU"]);
  } catch (e) {
    console.error("Hand model failed on CPU too", e);
    state.modelError = true;
  }
}

async function createLandmarker(HandLandmarker, vision, delegates = ["GPU", "CPU"]) {
  let lastError;
  for (const delegate of delegates) {
    try {
      return await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * Safari (Mac/iPhone) only lets a page make sound if audio is switched on during a click.
 * So on the Start click: create the audio, resume it, and play one silent sample.
 */
function unlockAudio() {
  const ctx = getAudio();
  if (!ctx) return;
  try {
    ctx.resume?.();
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    // ignore
  }
}
// If the browser suspends audio later (tab switch, Safari power saving), any click / key wakes it.
for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, () => audio?.state === "suspended" && audio.resume?.(), { passive: true });

async function startCamera() {
  startMsg.textContent = "";
  unlockAudio();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    startMsg.textContent = "The camera needs https or localhost. Open the GitHub Pages link, or run a local server (see README).";
    return;
  }
  startBtn.disabled = true;
  startBtn.textContent = "Starting camera…";
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    await video.play();
  } catch (e) {
    startBtn.disabled = false;
    startBtn.textContent = "Start camera";
    startMsg.textContent =
      e && e.name === "NotAllowedError"
        ? "Camera permission was blocked. Allow it from the address bar. On a Mac, also turn your browser on in System Settings → Privacy & Security → Camera."
        : e && e.name === "NotReadableError"
          ? "The camera is busy. Close other apps using it (Zoom, Meet, FaceTime) and try again."
          : `Couldn't open the camera (${(e && e.name) || "error"}). Try the mouse instead.`;
    return;
  }
  startEl.classList.add("hidden");
  body.classList.add("has-camera");
  state.source = "camera";
  if (state.mode === "music") setMode("music", false);
  setAR(true); // the "Iron Man" view: you on camera, holograms on top
  try {
    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    mp = { HandLandmarker, vision: await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM) };
    landmarker = await createLandmarker(mp.HandLandmarker, mp.vision);
  } catch (e) {
    console.error("Hand model failed to load", e);
    state.modelError = true;
  }
}

startBtn.addEventListener("click", startCamera);
$("mouseBtn").addEventListener("click", () => {
  unlockAudio();
  startEl.classList.add("hidden");
  state.source = "mouse";
  if (state.mode === "music") setMode("music", false);
});

/* ------------------------------------------------------------------ */
/* Mouse / touch fallback                                              */
/* ------------------------------------------------------------------ */

const stage = $("stage");
stage.addEventListener("contextmenu", (e) => e.preventDefault());

stage.addEventListener("pointerdown", (e) => {
  const p = { x: e.clientX, y: e.clientY };
  stage.setPointerCapture(e.pointerId);
  // Right-click, or Ctrl-click / two-finger click on a Mac trackpad.
  if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
    if (state.mode === "draw") board.remove(board.itemAt(p));
    else if (state.mode === "music") music.remove(music.itemAt(p));
    else {
      world.aim(p.x, p.y, "erase");
      world.beginSession("remove");
      if (world.removeHovered()) tick(300);
      world.endSession();
    }
    return;
  }
  state.mouse = { start: p, last: p, moved: false };
  if (state.mode === "music") music.beginStroke(p);
  else if (state.mode === "draw") {
    if (!board.startMove(board.itemAt(p), p)) board.beginStroke(p);
  }
});

stage.addEventListener("pointermove", (e) => {
  const p = { x: e.clientX, y: e.clientY };
  const m = state.mouse;
  if (!m) {
    if (state.mode === "build" && !state.hand) world.aim(p.x, p.y, "place");
    return;
  }
  if (Math.hypot(p.x - m.start.x, p.y - m.start.y) > 6) m.moved = true;
  if (state.mode === "music") music.extendStroke(p);
  else if (state.mode === "draw") {
    if (board.moving) {
      board.moveTo(p);
      showBin(true, overBin(p));
    } else board.extendStroke(p);
  } else if (m.moved) {
    world.hideGhost();
    world.orbit(((p.x - m.last.x) / window.innerWidth) * 0.5, ((p.y - m.last.y) / window.innerHeight) * 0.5);
  }
  m.last = p;
});

stage.addEventListener("pointerup", (e) => {
  const p = { x: e.clientX, y: e.clientY };
  const m = state.mouse;
  state.mouse = null;
  if (!m) return;
  if (state.mode === "music") {
    const item = music.endStroke();
    if (item) toast(music.label(item));
  } else if (state.mode === "draw") {
    if (board.moving) {
      if (board.endMove(overBin(p))) toast("Deleted");
      showBin(false);
    } else {
      const item = board.endStroke();
      if (item) {
        toast(LABELS[item.type]);
        tick(660);
      }
    }
  } else if (!m.moved) {
    world.aim(p.x, p.y, "place");
    world.beginSession("add");
    if (world.place()) tick(600);
    world.endSession();
  }
});

stage.addEventListener(
  "wheel",
  (e) => {
    if (state.mode !== "build") return;
    e.preventDefault();
    world.zoom(e.deltaY);
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") {
    e.preventDefault();
    return undo(); // Ctrl+Z on Windows, Cmd+Z on Mac
  }
  if (e.altKey || e.metaKey || e.ctrlKey) return;
  if (k === "b") setMode("build");
  else if (k === "d") setMode("draw");
  else if (k === "n") setMode("music");
  else if (k === " ") {
    e.preventDefault();
    togglePlay();
  }
  else if (k === "z") undo();
  else if (k === "c") body.classList.toggle("preview");
  else if (k === "h") body.classList.toggle("skeleton");
  else if (k === "u") body.classList.toggle("no-ui");
  else if (k === "m") {
    state.sound = !state.sound;
    music.setMuted(!state.sound);
    toast(state.sound ? "Sound on" : "Sound off");
  }
  else if (k === "a") setAR(!state.ar);
  else if (k === "x") smash();
  else if (k === "t") make3D();
  else if (k === "f") {
    const el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); // webkit* = older Safari
  }
});

/* ------------------------------------------------------------------ */
/* Overlay: hand lines + cursor                                        */
/* ------------------------------------------------------------------ */

function resize() {
  world.resize();
  board.resize();
  music.resize();
  const dpr = Math.min(window.devicePixelRatio, 2);
  overlay.width = Math.round(window.innerWidth * dpr);
  overlay.height = Math.round(window.innerHeight * dpr);
}
window.addEventListener("resize", resize);
resize();

function drawOverlay(now) {
  const dpr = overlay.width / window.innerWidth;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!state.hand || !state.cursor) return;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (body.classList.contains("skeleton")) {
    const pts = state.hand.map((p) => toScreen({ x: 1 - p.x, y: p.y }, false));
    octx.save();
    octx.lineCap = "round";
    octx.lineWidth = 2;
    octx.strokeStyle = "rgba(0, 229, 255, 0.5)";
    octx.shadowColor = "#00e5ff";
    octx.shadowBlur = 10;
    octx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      octx.moveTo(pts[a].x, pts[a].y);
      octx.lineTo(pts[b].x, pts[b].y);
    }
    octx.stroke();
    octx.fillStyle = "rgba(200, 248, 255, 0.85)";
    for (const p of pts) {
      octx.beginPath();
      octx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      octx.fill();
    }
    octx.restore();
  }

  const { x, y } = state.cursor;
  const pose = state.pose;
  octx.save();
  octx.lineWidth = 2.5;
  if (pose === "pinch" && state.mode === "music") {
    octx.fillStyle = music.color;
    octx.shadowColor = music.color;
    octx.shadowBlur = 18;
    octx.beginPath();
    octx.arc(x, y, 7, 0, Math.PI * 2);
    octx.fill();
  } else if (pose === "pinch") {
    octx.fillStyle = "rgba(255, 61, 242, 0.35)";
    octx.strokeStyle = "#ff3df2";
    octx.shadowColor = "#ff3df2";
    octx.shadowBlur = 16;
    octx.beginPath();
    octx.arc(x, y, 14, 0, Math.PI * 2);
    octx.fill();
    octx.stroke();
  } else if (pose === "fist") {
    const progress = state.mode !== "build" && state.eraseTarget ? clamp((now - state.eraseStart) / 450, 0, 1) : 1;
    octx.strokeStyle = "rgba(255, 77, 94, 0.35)";
    octx.beginPath();
    octx.arc(x, y, 20, 0, Math.PI * 2);
    octx.stroke();
    octx.strokeStyle = "#ff4d5e";
    octx.shadowColor = "#ff4d5e";
    octx.shadowBlur = 14;
    octx.beginPath();
    octx.arc(x, y, 20, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    octx.stroke();
  } else if (pose === "open") {
    octx.setLineDash([5, 6]);
    octx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    octx.beginPath();
    octx.arc(x, y, 26, 0, Math.PI * 2);
    octx.stroke();
  } else {
    const color = state.mode === "draw" ? state.color : state.mode === "music" ? music.color : "#ffffff";
    octx.fillStyle = color;
    octx.strokeStyle = color;
    octx.shadowColor = color;
    octx.shadowBlur = 14;
    octx.beginPath();
    octx.arc(x, y, state.mode === "build" ? 4 : 6, 0, Math.PI * 2);
    octx.fill();
    if (state.mode === "build") {
      octx.beginPath();
      octx.arc(x, y, 16, 0, Math.PI * 2);
      octx.stroke();
    }
  }
  if (state.action) {
    octx.shadowBlur = 0;
    octx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    octx.fillStyle = "rgba(232, 246, 255, 0.85)";
    octx.textAlign = "center";
    octx.fillText(state.action.toUpperCase(), x, y + 42);
  }
  octx.restore();
}

let lastStatus = "";
function updateStatus() {
  const modeName = MODE_NAMES[state.mode];
  const musicInfo = () => `${music.items.length} part${music.items.length === 1 ? "" : "s"} · ${music.instrument.name} · ${music.bpm} BPM`;
  let text;
  let cls = "chip";
  if (state.source === "camera" && state.modelError) {
    text = "Hand model failed to load · check your internet and refresh";
    cls += " warn";
  } else if (state.source === "camera" && !landmarker) text = "Loading hand model…";
  else if (state.hand) {
    const count =
      state.mode === "build"
        ? `${world.count} brick${world.count === 1 ? "" : "s"}`
        : state.mode === "music"
          ? musicInfo()
          : `${board.items.length} item${board.items.length === 1 ? "" : "s"}`;
    text = `${modeName} · ${state.action || "21 points tracked"} · ${count}`;
    if (state.action && state.action !== "Aiming") cls += " active";
  } else if (state.source === "camera") text = `${modeName} · show your hand to the camera`;
  else if (state.source === "mouse")
    text =
      state.mode === "build"
        ? "Build · click to place · right-click to break · drag to rotate"
        : state.mode === "music"
          ? `Music · drag to draw · click for a drum · right-click to erase · ${musicInfo()}`
          : "Draw · drag to draw · drag a shape to move it";
  else text = "Ready";
  if (text + cls !== lastStatus) {
    statusEl.textContent = text;
    statusEl.className = cls;
    lastStatus = text + cls;
  }
}

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */

let lastFrame = performance.now();
let lastVideoTime = -1;

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    let res;
    try {
      res = landmarker.detectForVideo(video, now);
    } catch (err) {
      // Some browsers (notably Safari) accept the GPU path but fail when running it.
      console.warn("Hand tracking error, switching to CPU", err);
      landmarker = null;
      reloadOnCPU();
      res = { landmarks: [] };
    }
    if (res.landmarks && res.landmarks.length) onHand(res.landmarks[0], now, video.videoWidth, video.videoHeight);
    else onNoHand(now);
  }

  if (state.mode === "build") world.render(dt, now);
  else if (state.mode === "music") music.render(now, { hover: state.hoverItem, erase: state.eraseTarget });
  else board.render(now, { hover: state.hoverItem, erase: state.eraseTarget });
  drawOverlay(now);
  updateStatus();
  requestAnimationFrame(frame);
}

setColor(state.color);
setMode("music", false); // opens straight into the music stage (like the video)
requestAnimationFrame(frame);

// Debug API (used by the tests; handy in the browser console).
window.air = {
  get state() {
    return {
      mode: state.mode,
      source: state.source,
      pose: state.pose,
      pinching: state.pinching,
      action: state.action,
      cursor: state.cursor && { x: Math.round(state.cursor.x), y: Math.round(state.cursor.y) },
      items: board.items.map((i) => i.type),
      bricks: world.count,
      color: state.color,
      ar: Boolean(state.ar),
      azim: Number(world.viewGoal.azim.toFixed(3)),
      modelReady: Boolean(landmarker),
      modelError: state.modelError,
      music: music.summary(),
    };
  },
  simulate(landmarks, at = performance.now()) {
    onHand(landmarks, at, video.videoWidth || 1280, video.videoHeight || 720);
  },
  noHand(at = performance.now()) {
    onNoHand(at + 1000);
  },
  setMode,
  world,
  board,
  music,
};
