// Build mode: Lego-style bricks on a 3D grid.
// Aim with a screen point; place on the floor or on any face of an existing brick.
import * as THREE from "three";

const GRID = 15; // cells per side
const HALF = Math.floor(GRID / 2);
const MAX_HEIGHT = 16;
const key = (i, j, k) => `${i},${j},${k}`;

function bounceOut(t) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

export class BrickWorld {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a12);
    this.scene.fog = new THREE.Fog(0x070a12, 28, 60);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.view = { azim: 0.75, elev: 0.82, dist: 22, target: new THREE.Vector3(0, 1, 0) };
    this.viewGoal = { azim: this.view.azim, elev: this.view.elev };

    this.scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x0b0f1a, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(8, 16, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
    this.scene.add(sun);

    // Floor + neon grid
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(GRID, GRID), new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.material.transparent = true;
    this.floor = floor;
    this.scene.add(floor);
    this.flying = []; // smashed bricks
    this.drops = []; // bricks raining in from Make 3D
    const grid = new THREE.GridHelper(GRID, GRID, 0x00e5ff, 0x1d4a66);
    grid.position.y = 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    this.scene.add(grid);
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(GRID, 0.02, GRID)),
      new THREE.LineBasicMaterial({ color: 0x00e5ff }),
    );
    border.position.y = 0.01;
    this.scene.add(border);

    // Shared brick parts
    this.boxGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    this.studGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.16, 20);
    this.edgeGeo = new THREE.EdgesGeometry(this.boxGeo);
    this.hitGeo = new THREE.BoxGeometry(1, 1, 1);
    this.hitMat = new THREE.MeshBasicMaterial({ visible: false });
    this.materials = new Map();

    this.bricks = new Map(); // key -> { group, box, cell, color }
    this.boxes = []; // meshes for raycasting
    this.popping = [];
    this.history = [];
    this.session = null; // current place/erase stroke for undo

    // Ghost brick
    this.ghost = new THREE.Group();
    this.ghostFill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.22, depthWrite: false }));
    this.ghostEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)), new THREE.LineBasicMaterial({ color: 0x00e5ff }));
    this.ghost.add(this.ghostFill, this.ghostEdge);
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.target = null; // cell where a brick would go
    this.hovered = null; // brick under the cursor
    this.color = "#00e5ff";
    this.resize();
  }

  get count() {
    return this.bricks.size;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setColor(hex) {
    this.color = hex;
  }

  material(hex) {
    if (!this.materials.has(hex)) {
      const c = new THREE.Color(hex);
      this.materials.set(hex, {
        body: new THREE.MeshStandardMaterial({ color: c, roughness: 0.32, metalness: 0.05, emissive: c, emissiveIntensity: 0.14 }),
        edge: new THREE.LineBasicMaterial({ color: c.clone().lerp(new THREE.Color(0xffffff), 0.5), transparent: true, opacity: 0.6 }),
      });
    }
    return this.materials.get(hex);
  }

  /* ---- view ---- */

  orbit(dx, dy) {
    this.viewGoal.azim -= dx * 5;
    this.viewGoal.elev = Math.min(1.35, Math.max(0.2, this.viewGoal.elev + dy * 3));
  }

  /** AR: transparent background so the webcam video shows through. */
  setAR(on) {
    this.scene.background = on ? null : new THREE.Color(0x070a12);
    this.scene.fog = on ? null : new THREE.Fog(0x070a12, 28, 60);
    this.floor.material.opacity = on ? 0.3 : 1;
    this.renderer.setClearColor(0x000000, on ? 0 : 1);
  }

  /** Builds many bricks at once, raining down in order (used by Make 3D). */
  buildCells(cells) {
    const now = performance.now();
    const order = [...cells].sort((a, b) => a.j - b.j || Math.hypot(a.i, a.k) - Math.hypot(b.i, b.k));
    const changes = [];
    let n = 0;
    for (const c of order) {
      if (!this.inBounds(c) || this.bricks.has(key(c.i, c.j, c.k))) continue;
      const brick = this.addBrick(c, c.color, false);
      brick.group.visible = false;
      this.drops.push({ group: brick.group, toY: c.j + 0.5, start: now + n * 14 });
      changes.push({ cell: { i: c.i, j: c.j, k: c.k }, color: c.color });
      n++;
    }
    if (changes.length) this.history.push({ type: "add", changes });
    return changes.length;
  }

  /** Smash: every brick flies apart, bounces and fades. Undo brings them back. */
  smash() {
    if (!this.bricks.size) return false;
    const changes = [];
    const now = performance.now();
    for (const b of [...this.bricks.values()]) {
      changes.push({ cell: b.cell, color: b.color });
      this.scene.remove(b.hit);
      this.bricks.delete(key(b.cell.i, b.cell.j, b.cell.k));
      const out = new THREE.Vector3(b.cell.i, 0, b.cell.k);
      if (out.lengthSq() < 0.01) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      out.normalize().multiplyScalar(4 + Math.random() * 6);
      this.flying.push({
        group: b.group,
        v: new THREE.Vector3(out.x + (Math.random() - 0.5) * 3, 7 + Math.random() * 8 + b.cell.j * 0.8, out.z + (Math.random() - 0.5) * 3),
        w: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5),
        start: now,
      });
    }
    this.boxes = [];
    this.popping = [];
    this.drops = [];
    this.history.push({ type: "remove", changes });
    this.hideGhost();
    return true;
  }

  zoom(deltaY) {
    this.view.dist = Math.min(40, Math.max(10, this.view.dist * Math.exp(deltaY * 0.001)));
  }

  resetView(azim = 0.75, elev = 0.82, targetY = 1, dist = 22) {
    this.viewGoal = { azim, elev };
    this.view.target.y = targetY;
    this.view.dist = dist;
  }

  /* ---- aiming ---- */

  inBounds(c) {
    return Math.abs(c.i) <= HALF && Math.abs(c.k) <= HALF && c.j >= 0 && c.j < MAX_HEIGHT;
  }

  setRay(sx, sy) {
    this.ndc.set((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  /** Point on the horizontal plane at height y, or null. */
  planeHit(y) {
    const { origin, direction } = this.raycaster.ray;
    if (Math.abs(direction.y) < 1e-4) return null;
    const t = (y - origin.y) / direction.y;
    return t > 0 ? origin.clone().addScaledVector(direction, t) : null;
  }

  /**
   * Updates target/hovered for a screen point (CSS px).
   * While painting, the target stays on the layer you started on, so a drag lays a wall
   * or a floor instead of stacking a tower under your finger.
   */
  aim(sx, sy, mode = "place") {
    this.setRay(sx, sy);
    const hit = this.raycaster.intersectObjects(this.boxes, false)[0];
    this.hovered = hit ? hit.object.userData.brick : null;

    let target = null;
    if (this.session && this.session.type === "add" && this.session.layer !== undefined) {
      const p = this.planeHit(this.session.layer + 0.5);
      if (p) target = { i: Math.round(p.x), j: this.session.layer, k: Math.round(p.z) };
    } else if (hit) {
      const c = hit.object.userData.brick.cell;
      const n = hit.face.normal;
      target = { i: c.i + Math.round(n.x), j: c.j + Math.round(n.y), k: c.k + Math.round(n.z) };
    } else {
      const p = this.planeHit(0);
      if (p) target = { i: Math.round(p.x), j: 0, k: Math.round(p.z) };
    }
    this.target = target && this.inBounds(target) ? target : null;

    if (mode === "erase") {
      this.ghost.visible = Boolean(this.hovered);
      if (this.hovered) this.showGhost(this.hovered.cell, 0xff4d5e);
    } else if (mode === "place") {
      this.ghost.visible = Boolean(this.target);
      if (this.target) this.showGhost(this.target, this.color);
    } else this.ghost.visible = false;
  }

  hideGhost() {
    this.ghost.visible = false;
    this.target = null;
    this.hovered = null;
  }

  showGhost(c, color) {
    this.ghost.position.set(c.i, c.j + 0.5, c.k);
    this.ghostFill.material.color.set(color);
    this.ghostEdge.material.color.set(color);
  }

  /* ---- editing ---- */

  beginSession(type) {
    this.session = { type, changes: [] };
  }

  endSession() {
    if (this.session && this.session.changes.length) this.history.push(this.session);
    if (this.history.length > 80) this.history.shift();
    this.session = null;
  }

  /** Places a brick at the current target. Returns true if one was added. */
  place() {
    const c = this.target;
    if (!c || this.bricks.has(key(c.i, c.j, c.k))) return false;
    this.addBrick(c, this.color);
    if (this.session) {
      this.session.changes.push({ cell: c, color: this.color });
      if (this.session.layer === undefined) this.session.layer = c.j;
    }
    return true;
  }

  /** Removes the hovered brick. Returns true if one was removed. */
  removeHovered() {
    const b = this.hovered;
    if (!b) return false;
    this.removeBrick(b.cell);
    if (this.session) this.session.changes.push({ cell: b.cell, color: b.color });
    this.hovered = null;
    return true;
  }

  addBrick(c, color, animate = true) {
    const m = this.material(color);
    const group = new THREE.Group();
    const box = new THREE.Mesh(this.boxGeo, m.body);
    box.castShadow = box.receiveShadow = true;
    const stud = new THREE.Mesh(this.studGeo, m.body);
    stud.position.y = 0.56;
    stud.castShadow = true;
    group.add(box, stud, new THREE.LineSegments(this.edgeGeo, m.edge));
    group.position.set(c.i, c.j + 0.5, c.k);
    // Invisible full-size hit box: aiming works at once, even while the brick pops in.
    const hit = new THREE.Mesh(this.hitGeo, this.hitMat);
    hit.position.copy(group.position);
    hit.updateMatrixWorld(true);
    const brick = { group, hit, cell: { ...c }, color };
    hit.userData.brick = brick;
    this.scene.add(group, hit);
    this.bricks.set(key(c.i, c.j, c.k), brick);
    this.boxes.push(hit);
    if (animate) {
      // Animation runs on the screen clock (performance.now), not the gesture clock.
      group.scale.setScalar(0.2);
      this.popping.push({ group, start: performance.now() });
    }
    return brick;
  }

  removeBrick(c) {
    const k = key(c.i, c.j, c.k);
    const b = this.bricks.get(k);
    if (!b) return;
    this.scene.remove(b.group, b.hit);
    this.bricks.delete(k);
    this.boxes = this.boxes.filter((x) => x !== b.hit);
  }

  undo() {
    const last = this.history.pop();
    if (!last) return false;
    for (const ch of [...last.changes].reverse()) {
      if (last.type === "add") this.removeBrick(ch.cell);
      else this.addBrick(ch.cell, ch.color, false);
    }
    return true;
  }

  clear() {
    if (!this.bricks.size) return false;
    const changes = [...this.bricks.values()].map((b) => ({ cell: b.cell, color: b.color }));
    for (const ch of changes) this.removeBrick(ch.cell);
    this.history.push({ type: "remove", changes });
    return true;
  }

  /* ---- frame ---- */

  render(dt, now) {
    const k = 1 - Math.exp(-dt * 8);
    this.view.azim += (this.viewGoal.azim - this.view.azim) * k;
    this.view.elev += (this.viewGoal.elev - this.view.elev) * k;
    const { azim, elev, dist, target } = this.view;
    this.camera.position.set(
      target.x + dist * Math.cos(elev) * Math.sin(azim),
      target.y + dist * Math.sin(elev),
      target.z + dist * Math.cos(elev) * Math.cos(azim),
    );
    this.camera.lookAt(target);

    this.popping = this.popping.filter(({ group, start }) => {
      const t = Math.min(1, (now - start) / 200);
      const s = 1 + 1.7 * Math.pow(t - 1, 3) + 0.7 * Math.pow(t - 1, 2); // ease-out-back
      group.scale.setScalar(Math.max(0.2, s));
      return t < 1;
    });

    // Make 3D: bricks fall from the sky and bounce into place.
    this.drops = this.drops.filter((d) => {
      const t = (now - d.start) / 520;
      if (t < 0) return true;
      d.group.visible = true;
      const k = Math.min(1, t);
      d.group.position.y = d.toY + 14 * (1 - bounceOut(k));
      return k < 1;
    });

    // Smash: simple physics, bounce on the floor, then shrink away.
    const g = 26;
    this.flying = this.flying.filter((f) => {
      const age = (now - f.start) / 1000;
      f.v.y -= g * dt;
      f.group.position.addScaledVector(f.v, dt);
      if (f.group.position.y < 0.5) {
        f.group.position.y = 0.5;
        f.v.y = Math.abs(f.v.y) * 0.38;
        f.v.x *= 0.75;
        f.v.z *= 0.75;
        f.w.multiplyScalar(0.7);
      }
      f.group.rotation.x += f.w.x * dt;
      f.group.rotation.y += f.w.y * dt;
      f.group.rotation.z += f.w.z * dt;
      if (age > 1.8) f.group.scale.setScalar(Math.max(0, 1 - (age - 1.8) / 0.6));
      if (age > 2.4) {
        this.scene.remove(f.group);
        return false;
      }
      return true;
    });

    if (this.ghost.visible) this.ghostFill.material.opacity = 0.18 + 0.1 * Math.sin(now / 180);
    this.renderer.render(this.scene, this.camera);
  }
}
