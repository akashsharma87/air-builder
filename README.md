# Air Builder

Build with Lego-style bricks and sketch diagrams **in the air**, using only your hand and a laptop webcam. No mouse, no keyboard, no install.

<!-- Add a demo GIF here: record 5–8 seconds of the screen, save as demo.gif in this folder, then:
![Demo](demo.gif)
-->

## Quick start

### On a Mac

**Easiest (no Terminal):**
1. On GitHub, click the green **Code** button → **Download ZIP**, and unzip it.
2. Open the folder and double-click **`start-mac.command`**. (First time only: if macOS blocks it, right-click → **Open** → **Open**.)
3. The app opens at **http://localhost:8000**. Click **Start camera** and allow it.

**With Terminal** (copy-paste these 3 lines):

```bash
git clone https://github.com/akashsharma87/air-builder.git
cd air-builder
sh start-mac.command
```

This repo is private, so the first clone asks for your GitHub login. Use your username, and for the password a [personal access token](https://github.com/settings/tokens) (GitHub no longer accepts account passwords here). Or skip that by installing GitHub CLI once (`brew install gh`, then `gh auth login`) and cloning with `gh repo clone akashsharma87/air-builder`.

**Get the latest version later:**

```bash
cd air-builder
git pull
```

### On Windows

Double-click **`start-windows.bat`**, then open **http://localhost:8000**.

To stop it on either system, close the Terminal / command window.

## Two modes

### Build: stack bricks
| Gesture | What it does |
|---|---|
| ☝️ **Point** | Aim: a ghost brick shows where it will go |
| 🤏 **Pinch** | Place a brick (on the floor or on any side of another brick) |
| 🤏 **Pinch + drag** | Lay a whole row, wall or floor in one go |
| ✊ **Fist** | Break the brick you're pointing at (keep moving to break more) |
| ✋ **Open palm + move** | Rotate the whole build |

### Draw: diagrams like a whiteboard app
| Gesture | What it does |
|---|---|
| ☝️ **Point** | Draw (pen down) |
| ✋ **Open palm** | Lift the pen: your scribble snaps into a clean **rectangle, circle, triangle or arrow** |
| ↔️ **Line from one shape to another** | Becomes a **connector** that follows the shapes |
| 🤏 **Pinch a shape** | Move it. Drop it on the red bin to delete it |
| ✊ **Fist on a shape** (half a second) | Erase it |

### The wow buttons
- **AR**: your real webcam video fills the screen and the bricks, drawings and hand lines float on top of it, lined up with your real hand. Turns on automatically when you start the camera.
- **Make 3D** (Draw mode): your drawing stands up as a Lego build, exactly as drawn. Bricks rain down and bounce into place, bottom row first.
- **Smash** (Build mode): the whole build explodes. Bricks fly, bounce and fade out. Undo brings it all back.

### The floating toolbar
Point at a button and **pinch** to press it: switch Build / Draw, pick a colour, AR, Make 3D / Smash, Undo, Clear.

**No camera?** Click *Use the mouse*. Build: click to place, right-click to break, drag to rotate, scroll to zoom. Draw: drag to draw, drag a shape to move it, right-click to delete.

**Keys:** `B` build · `D` draw · `Z` undo · `A` AR · `T` make 3D · `X` smash · `C` camera preview · `H` hand lines · `U` hide the UI (for clean screen recordings) · `M` sound on/off · `F` fullscreen.

## How it works

1. **MediaPipe Hand Landmarker** finds **21 points** on your hand in every webcam frame, inside the browser.
2. `gestures.js` reads those points. Every distance is divided by your palm length, so it works near or far from the camera.
   - Pose = which fingers are out (point, pinch, open palm, fist), with hysteresis and a two-frame check so it doesn't flicker.
   - The cursor is your index fingertip, smoothed with a One Euro filter (steady when you hold still, quick when you move). The edges of the camera image are ignored so the whole screen is easy to reach.
3. **Build** (`build.js`): Three.js raycasts from the cursor into the scene. If it hits a brick, the new brick goes on that face; otherwise on the floor grid. Drag-placing stays on one layer, so you lay walls instead of accidental towers.
4. **Draw** (`draw.js`, `recognize.js`): a finished stroke is classified by how much of its bounding box it fills: ~100% rectangle, ~78% circle, ~50% triangle; open strokes become arrows or freehand lines.

```
index.html    page + import map (Three.js and MediaPipe from jsDelivr)
style.css     toolbar, HUD, bin, start screen
app.js        camera, hand loop, gestures → actions, toolbar, mouse fallback
gestures.js   pose, pinch, smoothing (pure maths)
recognize.js  stroke → rectangle / circle / triangle / arrow (pure maths)
build.js      3D brick world
draw.js       diagram board
```

## Run it on your computer (Mac or Windows)

The easiest way for anyone is the GitHub Pages link: nothing to install. To run it from this folder, the camera needs `localhost`, so start a tiny local server instead of double-clicking `index.html`:

| | One click | Or in a terminal |
|---|---|---|
| **Mac** | Double-click **start-mac.command** | `cd air-builder` then `python3 -m http.server 8000` |
| **Windows** | Double-click **start-windows.bat** | `cd air-builder` then `python -m http.server 8000` |

Then open **http://localhost:8000** (the one-click scripts open it for you).

**Mac notes**
- First time: if macOS says the file "can't be opened", right-click it → **Open** → **Open**. If it says you don't have permission, run `sh start-mac.command` in Terminal instead (or `chmod +x start-mac.command` once).
- No Python yet? Type `python3` in Terminal and macOS offers to install it (free, one click).
- Camera blocked? Turn your browser on in **System Settings → Privacy & Security → Camera**, then reload.
- Works in **Chrome, Safari 17+, Edge and Firefox**. Trackpad: **two-finger click or Ctrl-click** = right-click, **pinch** = zoom, **Cmd+Z** = undo.

**Windows notes**
- No Python? Get it from [python.org](https://www.python.org/downloads/) and tick **"Add python.exe to PATH"** while installing.
- Camera blocked? **Settings → Privacy & security → Camera** → allow desktop apps / your browser.

**Both:** close Zoom, Meet or any other app using the camera first.

## Put it online (for your audience)

To share it with viewers (the "comment HAND, I'll send the link" reels), they need a public link:

1. Make the repo public: **Settings → General → Danger Zone → Change visibility → Public**.
2. **Settings → Pages** → *Deploy from a branch* → `main` and `/ (root)` → Save.
3. A minute later it's live at `https://akashsharma87.github.io/air-builder/`, which works on any laptop with no install.

(GitHub Pages is free for public repos; for a private repo it needs a paid GitHub plan.)

## Tips for a good demo

- Light on your face and hand, plain background behind you.
- Keep your hand about an arm's length from the camera, palm facing it.
- Press `U` to hide the UI and `C` to hide the camera preview before screen-recording.

## Privacy

The webcam video is processed only in your browser and never uploaded. The page downloads Three.js and MediaPipe from jsDelivr and the hand model from Google's MediaPipe storage, and nothing else.

## Credits

[MediaPipe](https://developers.google.com/mediapipe) Hand Landmarker (Apache 2.0) · [Three.js](https://threejs.org) (MIT)

## Want something like this built?

I build websites, apps and AI agents. <!-- Add your Instagram / Topmate link here --> DM me **BUILD** on Instagram.

## License

MIT, see [LICENSE](LICENSE).
